/// Modbus server application — direct `AsyncAppHandler` implementation.
///
/// This is the "Level 2" explicit-loop approach recommended for tool
/// development: implement the `AsyncAppHandler` trait directly by matching on
/// `ModbusRequest` variants and constructing the appropriate `ModbusResponse`.
/// No macro-generated glue is involved, giving full control over every request.
///
/// Each data table (coils, discrete inputs, holding registers, input registers)
/// is backed by a flat 0–65535 array for values, plus a parallel registration
/// mask that tracks which addresses have been explicitly created by the server
/// UI. Any Modbus request that touches an address not in the registration mask
/// is rejected with `IllegalDataAddress`.
use std::sync::Arc;

use mbus_core::errors::ExceptionCode;
use mbus_core::function_codes::public::FunctionCode;
use modbus_rs::mbus_async::server::{
    AsyncAppHandler, AsyncTrafficNotifier, ModbusRequest, ModbusResponse,
};
use modbus_rs::UnitIdOrSlaveAddr;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADDR_SPACE: usize = 65_536;
/// Max coils per Modbus PDU (2000 coils = 250 packed bytes).
const MAX_COIL_BYTES: usize = 250;
/// Max registers per Modbus PDU (125 × 2 bytes = 250).
const MAX_REG_WORDS: usize = 125;

// ---------------------------------------------------------------------------
// Server data store
// ---------------------------------------------------------------------------

/// Shared in-memory Modbus data store.
///
/// `registered_*` masks control which addresses are "created" in the server UI.
/// Only registered addresses are served; all others return `IllegalDataAddress`.
pub struct ServerApp {
    coils: Vec<bool>,
    discrete_inputs: Vec<bool>,
    holding_regs: Vec<u16>,
    input_regs: Vec<u16>,
    registered_coils: Vec<bool>,
    registered_discrete_inputs: Vec<bool>,
    registered_holding_regs: Vec<bool>,
    registered_input_regs: Vec<bool>,
    /// Optional frame-level traffic sink.
    pub traffic_sink: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
}

impl ServerApp {
    pub fn new(traffic_sink: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>) -> Self {
        Self {
            coils: vec![false; ADDR_SPACE],
            discrete_inputs: vec![false; ADDR_SPACE],
            holding_regs: vec![0u16; ADDR_SPACE],
            input_regs: vec![0u16; ADDR_SPACE],
            registered_coils: vec![false; ADDR_SPACE],
            registered_discrete_inputs: vec![false; ADDR_SPACE],
            registered_holding_regs: vec![false; ADDR_SPACE],
            registered_input_regs: vec![false; ADDR_SPACE],
            traffic_sink,
        }
    }

    // ── Coil helpers ─────────────────────────────────────────────────────────

    fn pack_bools(src: &[bool]) -> ([u8; MAX_COIL_BYTES], usize) {
        let byte_count = (src.len() + 7) / 8;
        let mut buf = [0u8; MAX_COIL_BYTES];
        for (i, &v) in src.iter().enumerate() {
            if v {
                buf[i / 8] |= 1 << (i % 8);
            }
        }
        (buf, byte_count)
    }

    fn unpack_coils(dst: &mut [bool], packed: &[u8]) {
        for (i, slot) in dst.iter_mut().enumerate() {
            *slot = (packed[i / 8] >> (i % 8)) & 1 != 0;
        }
    }

    // ── Coil data-store accessors (for Tauri UI commands) ────────────────────

    /// Register and set a single coil value. Registers the address if not already registered.
    pub fn set_coil(&mut self, address: u16, value: bool) {
        let idx = address as usize;
        if idx < ADDR_SPACE {
            self.coils[idx] = value;
            self.registered_coils[idx] = true;
        }
    }

    /// Register and set multiple coil values.
    pub fn set_coils_batch(&mut self, coils: &[(u16, bool)]) {
        for &(address, value) in coils {
            self.set_coil(address, value);
        }
    }

    /// Unregister a coil address and reset its value.
    pub fn remove_coil(&mut self, address: u16) {
        let idx = address as usize;
        if idx < ADDR_SPACE {
            self.registered_coils[idx] = false;
            self.coils[idx] = false;
        }
    }

    /// Unregister all coil addresses and reset all values.
    pub fn clear_coils(&mut self) {
        self.registered_coils.fill(false);
        self.coils.fill(false);
    }

    /// Replace the registered coil address set with `addresses`.
    /// Addresses already registered keep their values; new addresses start at `false`.
    /// Addresses removed from the set are unregistered and reset to `false`.
    pub fn sync_coil_addresses(&mut self, addresses: &[u16]) {
        self.registered_coils.fill(false);
        for &addr in addresses {
            let idx = addr as usize;
            if idx < ADDR_SPACE {
                self.registered_coils[idx] = true;
            }
        }
    }

    // ── Discrete input data-store accessors ──────────────────────────────────

    /// Register and set a single discrete input value.
    pub fn set_discrete_input(&mut self, address: u16, value: bool) {
        let idx = address as usize;
        if idx < ADDR_SPACE {
            self.discrete_inputs[idx] = value;
            self.registered_discrete_inputs[idx] = true;
        }
    }

    /// Register and set multiple discrete input values.
    pub fn set_discrete_inputs_batch(&mut self, inputs: &[(u16, bool)]) {
        for &(address, value) in inputs {
            self.set_discrete_input(address, value);
        }
    }

    /// Unregister a discrete input address and reset its value.
    pub fn remove_discrete_input(&mut self, address: u16) {
        let idx = address as usize;
        if idx < ADDR_SPACE {
            self.registered_discrete_inputs[idx] = false;
            self.discrete_inputs[idx] = false;
        }
    }

    /// Unregister all discrete input addresses and reset all values.
    pub fn clear_discrete_inputs(&mut self) {
        self.registered_discrete_inputs.fill(false);
        self.discrete_inputs.fill(false);
    }

    /// Replace the registered discrete input address set with `addresses`.
    pub fn sync_discrete_input_addresses(&mut self, addresses: &[u16]) {
        self.registered_discrete_inputs.fill(false);
        for &addr in addresses {
            let idx = addr as usize;
            if idx < ADDR_SPACE {
                self.registered_discrete_inputs[idx] = true;
            }
        }
    }

    // ── Holding register data-store accessors ─────────────────────────────────

    /// Register and set a single holding register value.
    pub fn set_holding_reg(&mut self, address: u16, value: u16) {
        let idx = address as usize;
        if idx < ADDR_SPACE {
            self.holding_regs[idx] = value;
            self.registered_holding_regs[idx] = true;
        }
    }

    /// Register and set multiple holding register values.
    pub fn set_holding_regs_batch(&mut self, regs: &[(u16, u16)]) {
        for &(address, value) in regs {
            self.set_holding_reg(address, value);
        }
    }

    /// Unregister a holding register address and reset its value.
    pub fn remove_holding_reg(&mut self, address: u16) {
        let idx = address as usize;
        if idx < ADDR_SPACE {
            self.registered_holding_regs[idx] = false;
            self.holding_regs[idx] = 0;
        }
    }

    /// Unregister all holding register addresses and reset all values.
    pub fn clear_holding_regs(&mut self) {
        self.registered_holding_regs.fill(false);
        self.holding_regs.fill(0);
    }

    /// Replace the registered holding register address set with `addresses`.
    pub fn sync_holding_reg_addresses(&mut self, addresses: &[u16]) {
        self.registered_holding_regs.fill(false);
        for &addr in addresses {
            let idx = addr as usize;
            if idx < ADDR_SPACE {
                self.registered_holding_regs[idx] = true;
            }
        }
    }

    // ── Input register data-store accessors ───────────────────────────────────

    /// Register and set a single input register value.
    pub fn set_input_reg(&mut self, address: u16, value: u16) {
        let idx = address as usize;
        if idx < ADDR_SPACE {
            self.input_regs[idx] = value;
            self.registered_input_regs[idx] = true;
        }
    }

    /// Register and set multiple input register values.
    pub fn set_input_regs_batch(&mut self, regs: &[(u16, u16)]) {
        for &(address, value) in regs {
            self.set_input_reg(address, value);
        }
    }

    /// Unregister an input register address and reset its value.
    pub fn remove_input_reg(&mut self, address: u16) {
        let idx = address as usize;
        if idx < ADDR_SPACE {
            self.registered_input_regs[idx] = false;
            self.input_regs[idx] = 0;
        }
    }

    /// Unregister all input register addresses and reset all values.
    pub fn clear_input_regs(&mut self) {
        self.registered_input_regs.fill(false);
        self.input_regs.fill(0);
    }

    /// Replace the registered input register address set with `addresses`.
    pub fn sync_input_reg_addresses(&mut self, addresses: &[u16]) {
        self.registered_input_regs.fill(false);
        for &addr in addresses {
            let idx = addr as usize;
            if idx < ADDR_SPACE {
                self.registered_input_regs[idx] = true;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// AsyncTrafficNotifier — required super-trait
// ---------------------------------------------------------------------------

impl AsyncTrafficNotifier for ServerApp {
    fn on_rx_frame(&mut self, txn_id: u16, unit: UnitIdOrSlaveAddr, frame: &[u8]) {
        if let Some(sink) = &self.traffic_sink {
            sink(format!(
                "srv.rx txn={txn_id} unit={} bytes={}",
                unit.get(),
                fmt_hex(frame)
            ));
        }
    }

    fn on_tx_frame(&mut self, txn_id: u16, unit: UnitIdOrSlaveAddr, frame: &[u8]) {
        if let Some(sink) = &self.traffic_sink {
            sink(format!(
                "srv.tx txn={txn_id} unit={} bytes={}",
                unit.get(),
                fmt_hex(frame)
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// AsyncAppHandler — the direct Level-2 interface
// ---------------------------------------------------------------------------

impl AsyncAppHandler for ServerApp {
    async fn handle(&mut self, req: ModbusRequest) -> ModbusResponse {
        match req {
            // ── FC01: Read Coils ──────────────────────────────────────────────
            ModbusRequest::ReadCoils {
                address, count, ..
            } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE
                    || self.registered_coils[start..end].iter().any(|&r| !r)
                {
                    return ModbusResponse::exception(
                        FunctionCode::ReadCoils,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                let (buf, byte_count) = Self::pack_bools(&self.coils[start..end]);
                ModbusResponse::packed_bits(FunctionCode::ReadCoils, &buf[..byte_count])
            }

            // ── FC05: Write Single Coil ───────────────────────────────────────
            ModbusRequest::WriteSingleCoil {
                address, value, ..
            } => {
                let idx = address as usize;
                if idx >= ADDR_SPACE || !self.registered_coils[idx] {
                    return ModbusResponse::exception(
                        FunctionCode::WriteSingleCoil,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                self.coils[idx] = value;
                ModbusResponse::echo_coil(address, value)
            }

            // ── FC0F: Write Multiple Coils ────────────────────────────────────
            ModbusRequest::WriteMultipleCoils {
                address,
                count,
                data,
                ..
            } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE
                    || self.registered_coils[start..end].iter().any(|&r| !r)
                {
                    return ModbusResponse::exception(
                        FunctionCode::WriteMultipleCoils,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                Self::unpack_coils(&mut self.coils[start..end], &data);
                ModbusResponse::echo_multi_write(
                    FunctionCode::WriteMultipleCoils,
                    address,
                    count,
                )
            }

            // ── FC02: Read Discrete Inputs ────────────────────────────────────
            ModbusRequest::ReadDiscreteInputs {
                address, count, ..
            } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE
                    || self.registered_discrete_inputs[start..end].iter().any(|&r| !r)
                {
                    return ModbusResponse::exception(
                        FunctionCode::ReadDiscreteInputs,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                let (buf, byte_count) = Self::pack_bools(&self.discrete_inputs[start..end]);
                ModbusResponse::packed_bits(
                    FunctionCode::ReadDiscreteInputs,
                    &buf[..byte_count],
                )
            }

            // ── FC03: Read Holding Registers ──────────────────────────────────
            ModbusRequest::ReadHoldingRegisters {
                address, count, ..
            } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE
                    || count as usize > MAX_REG_WORDS
                    || self.registered_holding_regs[start..end].iter().any(|&r| !r)
                {
                    return ModbusResponse::exception(
                        FunctionCode::ReadHoldingRegisters,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                ModbusResponse::registers(
                    FunctionCode::ReadHoldingRegisters,
                    &self.holding_regs[start..end],
                )
            }

            // ── FC06: Write Single Register ───────────────────────────────────
            ModbusRequest::WriteSingleRegister {
                address, value, ..
            } => {
                let idx = address as usize;
                if idx >= ADDR_SPACE || !self.registered_holding_regs[idx] {
                    return ModbusResponse::exception(
                        FunctionCode::WriteSingleRegister,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                self.holding_regs[idx] = value;
                ModbusResponse::echo_register(address, value)
            }

            // ── FC10: Write Multiple Registers ────────────────────────────────
            ModbusRequest::WriteMultipleRegisters {
                address,
                count,
                data,
                ..
            } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE
                    || count as usize > MAX_REG_WORDS
                    || self.registered_holding_regs[start..end].iter().any(|&r| !r)
                {
                    return ModbusResponse::exception(
                        FunctionCode::WriteMultipleRegisters,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                // `data` is big-endian byte pairs; convert to u16 in-place.
                for i in 0..(count as usize) {
                    let hi = data[i * 2] as u16;
                    let lo = data[i * 2 + 1] as u16;
                    self.holding_regs[start + i] = (hi << 8) | lo;
                }
                ModbusResponse::echo_multi_write(
                    FunctionCode::WriteMultipleRegisters,
                    address,
                    count,
                )
            }

            // ── FC04: Read Input Registers ────────────────────────────────────
            ModbusRequest::ReadInputRegisters {
                address, count, ..
            } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE
                    || count as usize > MAX_REG_WORDS
                    || self.registered_input_regs[start..end].iter().any(|&r| !r)
                {
                    return ModbusResponse::exception(
                        FunctionCode::ReadInputRegisters,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                ModbusResponse::registers(
                    FunctionCode::ReadInputRegisters,
                    &self.input_regs[start..end],
                )
            }

            // ── FC16: Mask Write Register ─────────────────────────────────────
            ModbusRequest::MaskWriteRegister {
                address,
                and_mask,
                or_mask,
                ..
            } => {
                let idx = address as usize;
                if idx >= ADDR_SPACE || !self.registered_holding_regs[idx] {
                    return ModbusResponse::exception(
                        FunctionCode::MaskWriteRegister,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                let current = self.holding_regs[idx];
                self.holding_regs[idx] = (current & and_mask) | (or_mask & !and_mask);
                ModbusResponse::echo_mask_write(address, and_mask, or_mask)
            }

            // ── FC17: Read/Write Multiple Registers ───────────────────────────
            ModbusRequest::ReadWriteMultipleRegisters {
                read_address,
                read_count,
                write_address,
                write_count,
                data,
                ..
            } => {
                let ws = write_address as usize;
                let we = ws + write_count as usize;
                let rs = read_address as usize;
                let re = rs + read_count as usize;
                if we > ADDR_SPACE
                    || re > ADDR_SPACE
                    || write_count as usize > MAX_REG_WORDS
                    || read_count as usize > MAX_REG_WORDS
                    || self.registered_holding_regs[ws..we].iter().any(|&r| !r)
                    || self.registered_holding_regs[rs..re].iter().any(|&r| !r)
                {
                    return ModbusResponse::exception(
                        FunctionCode::ReadWriteMultipleRegisters,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                // Write first (Modbus spec), then read.
                for i in 0..(write_count as usize) {
                    let hi = data[i * 2] as u16;
                    let lo = data[i * 2 + 1] as u16;
                    self.holding_regs[ws + i] = (hi << 8) | lo;
                }
                ModbusResponse::registers(
                    FunctionCode::ReadWriteMultipleRegisters,
                    &self.holding_regs[rs..re],
                )
            }

            // ── All other FCs: reply with Illegal Function ────────────────────
            other => {
                let fc_byte = other.function_code_byte();
                let fc = FunctionCode::try_from(fc_byte)
                    .unwrap_or(FunctionCode::ReadCoils); // fallback; never reached for known FCs
                ModbusResponse::exception(fc, ExceptionCode::IllegalFunction)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

fn fmt_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use mbus_core::errors::ExceptionCode;
    use mbus_core::function_codes::public::FunctionCode;
    use modbus_rs::mbus_async::server::{AsyncTcpServer, ModbusRequest, ModbusResponse};
    use modbus_rs::mbus_async::AsyncTcpClient;
    use modbus_rs::{UnitIdOrSlaveAddr, MAX_ADU_FRAME_LEN};
    use std::sync::Arc;
    use tokio::sync::Mutex;

    const UID: u8 = 1;

    fn unit() -> UnitIdOrSlaveAddr {
        UnitIdOrSlaveAddr::try_from(UID).unwrap()
    }

    // ── Layer 1: unit tests — ServerApp::handle() ─────────────────────────────

    #[tokio::test]
    async fn unit_fc01_unregistered_returns_exception() {
        let mut app = ServerApp::new(None);
        // Fresh server — no addresses registered — must return IllegalDataAddress
        let resp = app
            .handle(ModbusRequest::ReadCoils {
                txn_id: 1,
                unit: unit(),
                address: 0,
                count: 8,
            })
            .await;
        assert!(
            matches!(
                resp,
                ModbusResponse::Exception {
                    request_fc: FunctionCode::ReadCoils,
                    code: ExceptionCode::IllegalDataAddress
                }
            ),
            "unexpected: {resp:?}"
        );
    }

    #[tokio::test]
    async fn unit_fc01_registered_reads_false() {
        let mut app = ServerApp::new(None);
        // Register coils 0..7
        app.sync_coil_addresses(&[0, 1, 2, 3, 4, 5, 6, 7]);
        let resp = app
            .handle(ModbusRequest::ReadCoils {
                txn_id: 1,
                unit: unit(),
                address: 0,
                count: 8,
            })
            .await;
        match resp {
            ModbusResponse::ByteCountPayload { fc, data } => {
                assert_eq!(fc, FunctionCode::ReadCoils);
                assert_eq!(data[0], 0x00);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn unit_fc05_write_single_coil_echo_and_persist() {
        let mut app = ServerApp::new(None);
        // Register addr 3 so FC05 can write to it
        app.set_coil(3, false);
        let resp = app
            .handle(ModbusRequest::WriteSingleCoil {
                txn_id: 1,
                unit: unit(),
                address: 3,
                value: true,
            })
            .await;
        assert!(
            matches!(resp, ModbusResponse::EchoCoil { address: 3, raw_value: 0xFF00 }),
            "unexpected: {resp:?}"
        );
        // Verify persistence via FC01 read of addr 3 only
        let resp2 = app
            .handle(ModbusRequest::ReadCoils {
                txn_id: 2,
                unit: unit(),
                address: 3,
                count: 1,
            })
            .await;
        if let ModbusResponse::ByteCountPayload { data, .. } = resp2 {
            assert_eq!(data[0] & 1, 1, "coil 3 should be set");
        } else {
            panic!("expected ByteCountPayload");
        }
    }

    #[tokio::test]
    async fn unit_fc0f_write_multiple_coils() {
        let mut app = ServerApp::new(None);
        // Register coils 0..7 before writing
        app.sync_coil_addresses(&[0, 1, 2, 3, 4, 5, 6, 7]);
        // 0x55 = 0b0101_0101: coils 0,2,4,6 = true
        let mut data: modbus_rs::heapless::Vec<u8, MAX_ADU_FRAME_LEN> =
            modbus_rs::heapless::Vec::new();
        data.push(0x55).unwrap();
        let resp = app
            .handle(ModbusRequest::WriteMultipleCoils {
                txn_id: 1,
                unit: unit(),
                address: 0,
                count: 8,
                data,
            })
            .await;
        assert!(
            matches!(resp, ModbusResponse::EchoMultiWrite { .. }),
            "unexpected: {resp:?}"
        );
        let resp2 = app
            .handle(ModbusRequest::ReadCoils {
                txn_id: 2,
                unit: unit(),
                address: 0,
                count: 8,
            })
            .await;
        if let ModbusResponse::ByteCountPayload { data, .. } = resp2 {
            assert_eq!(data[0], 0x55);
        } else {
            panic!("expected ByteCountPayload");
        }
    }

    #[tokio::test]
    async fn unit_fc02_unregistered_returns_exception() {
        let mut app = ServerApp::new(None);
        let resp = app
            .handle(ModbusRequest::ReadDiscreteInputs {
                txn_id: 1,
                unit: unit(),
                address: 0,
                count: 8,
            })
            .await;
        assert!(
            matches!(
                resp,
                ModbusResponse::Exception {
                    request_fc: FunctionCode::ReadDiscreteInputs,
                    code: ExceptionCode::IllegalDataAddress
                }
            ),
            "unexpected: {resp:?}"
        );
    }

    #[tokio::test]
    async fn unit_fc03_unregistered_returns_exception() {
        let mut app = ServerApp::new(None);
        let resp = app
            .handle(ModbusRequest::ReadHoldingRegisters {
                txn_id: 1,
                unit: unit(),
                address: 0,
                count: 4,
            })
            .await;
        assert!(
            matches!(
                resp,
                ModbusResponse::Exception {
                    request_fc: FunctionCode::ReadHoldingRegisters,
                    code: ExceptionCode::IllegalDataAddress
                }
            ),
            "unexpected: {resp:?}"
        );
    }

    #[tokio::test]
    async fn unit_fc06_write_single_reg_echo_and_persist() {
        let mut app = ServerApp::new(None);
        // Register addr 10 so FC06 can write to it
        app.set_holding_reg(10, 0);
        let resp = app
            .handle(ModbusRequest::WriteSingleRegister {
                txn_id: 1,
                unit: unit(),
                address: 10,
                value: 0xABCD,
            })
            .await;
        assert!(
            matches!(resp, ModbusResponse::EchoRegister { address: 10, value: 0xABCD }),
            "unexpected: {resp:?}"
        );
        // Read back and verify
        let resp2 = app
            .handle(ModbusRequest::ReadHoldingRegisters {
                txn_id: 2,
                unit: unit(),
                address: 10,
                count: 1,
            })
            .await;
        if let ModbusResponse::ByteCountPayload { data, .. } = resp2 {
            let val = u16::from_be_bytes([data[0], data[1]]);
            assert_eq!(val, 0xABCD);
        } else {
            panic!("expected ByteCountPayload");
        }
    }

    #[tokio::test]
    async fn unit_fc10_write_multiple_regs() {
        let mut app = ServerApp::new(None);
        // Register addrs 20 and 21 before writing
        app.sync_holding_reg_addresses(&[20, 21]);
        // Encode [0x1234, 0x5678] as big-endian byte pairs
        let mut data: modbus_rs::heapless::Vec<u8, MAX_ADU_FRAME_LEN> =
            modbus_rs::heapless::Vec::new();
        for b in [0x12u8, 0x34, 0x56, 0x78] {
            data.push(b).unwrap();
        }
        let resp = app
            .handle(ModbusRequest::WriteMultipleRegisters {
                txn_id: 1,
                unit: unit(),
                address: 20,
                count: 2,
                data,
            })
            .await;
        assert!(
            matches!(resp, ModbusResponse::EchoMultiWrite { .. }),
            "unexpected: {resp:?}"
        );
        let resp2 = app
            .handle(ModbusRequest::ReadHoldingRegisters {
                txn_id: 2,
                unit: unit(),
                address: 20,
                count: 2,
            })
            .await;
        if let ModbusResponse::ByteCountPayload { data, .. } = resp2 {
            assert_eq!(u16::from_be_bytes([data[0], data[1]]), 0x1234);
            assert_eq!(u16::from_be_bytes([data[2], data[3]]), 0x5678);
        } else {
            panic!("expected ByteCountPayload");
        }
    }

    #[tokio::test]
    async fn unit_fc04_unregistered_returns_exception() {
        let mut app = ServerApp::new(None);
        let resp = app
            .handle(ModbusRequest::ReadInputRegisters {
                txn_id: 1,
                unit: unit(),
                address: 0,
                count: 4,
            })
            .await;
        assert!(
            matches!(
                resp,
                ModbusResponse::Exception {
                    request_fc: FunctionCode::ReadInputRegisters,
                    code: ExceptionCode::IllegalDataAddress
                }
            ),
            "unexpected: {resp:?}"
        );
    }

    #[tokio::test]
    async fn unit_fc16_mask_write_register() {
        let mut app = ServerApp::new(None);
        // Register addr 5 with initial value 0xF0F0
        app.set_holding_reg(5, 0xF0F0);
        // and_mask=0xFF00 keeps upper byte, or_mask=0x00AA sets lower bits
        // result = (0xF0F0 & 0xFF00) | (0x00AA & !0xFF00) = 0xF000 | 0x00AA = 0xF0AA
        let resp = app
            .handle(ModbusRequest::MaskWriteRegister {
                txn_id: 1,
                unit: unit(),
                address: 5,
                and_mask: 0xFF00,
                or_mask: 0x00AA,
            })
            .await;
        assert!(
            matches!(
                resp,
                ModbusResponse::EchoMaskWrite {
                    address: 5,
                    and_mask: 0xFF00,
                    or_mask: 0x00AA
                }
            ),
            "unexpected: {resp:?}"
        );
        assert_eq!(app.holding_regs[5], 0xF0AA);
    }

    #[tokio::test]
    async fn unit_fc17_read_write_multiple_regs() {
        let mut app = ServerApp::new(None);
        // Register addrs 30 and 31 before the combined read/write
        app.sync_holding_reg_addresses(&[30, 31]);
        // Write [0xDEAD, 0xBEEF] to addr 30 while reading 2 from addr 30
        let mut data: modbus_rs::heapless::Vec<u8, MAX_ADU_FRAME_LEN> =
            modbus_rs::heapless::Vec::new();
        for b in [0xDEu8, 0xAD, 0xBE, 0xEF] {
            data.push(b).unwrap();
        }
        let resp = app
            .handle(ModbusRequest::ReadWriteMultipleRegisters {
                txn_id: 1,
                unit: unit(),
                read_address: 30,
                read_count: 2,
                write_address: 30,
                write_count: 2,
                data,
            })
            .await;
        if let ModbusResponse::ByteCountPayload { fc, data } = resp {
            assert_eq!(fc, FunctionCode::ReadWriteMultipleRegisters);
            assert_eq!(u16::from_be_bytes([data[0], data[1]]), 0xDEAD);
            assert_eq!(u16::from_be_bytes([data[2], data[3]]), 0xBEEF);
        } else {
            panic!("expected ByteCountPayload");
        }
    }

    #[tokio::test]
    async fn unit_bounds_check_returns_illegal_data_address() {
        let mut app = ServerApp::new(None);
        // address 65535 + count 2 overflows the 65536-entry space
        let resp = app
            .handle(ModbusRequest::ReadCoils {
                txn_id: 1,
                unit: unit(),
                address: 65535,
                count: 2,
            })
            .await;
        assert!(
            matches!(
                resp,
                ModbusResponse::Exception {
                    request_fc: FunctionCode::ReadCoils,
                    code: ExceptionCode::IllegalDataAddress
                }
            ),
            "unexpected: {resp:?}"
        );
    }

    #[tokio::test]
    async fn unit_unknown_fc_returns_illegal_function() {
        let mut app = ServerApp::new(None);
        let resp = app
            .handle(ModbusRequest::Unknown {
                txn_id: 1,
                unit: unit(),
                function_code: 0x41,
            })
            .await;
        assert!(
            matches!(
                resp,
                ModbusResponse::Exception {
                    code: ExceptionCode::IllegalFunction,
                    ..
                }
            ),
            "unexpected: {resp:?}"
        );
    }

    // ── Layer 2: TCP integration tests ────────────────────────────────────────

    /// Binds a real `AsyncTcpServer` on a random loopback port, spawns the
    /// accept loop, and returns the port and a handle to the shared data store.
    async fn spawn_test_server() -> (u16, Arc<Mutex<ServerApp>>) {
        let unit = unit();
        let shared = Arc::new(Mutex::new(ServerApp::new(None)));
        // Pre-register addresses 0..64 for all tables so integration tests can
        // read and write freely without triggering IllegalDataAddress.
        {
            let mut app = shared.lock().await;
            let range: Vec<u16> = (0u16..64).collect();
            app.sync_coil_addresses(&range);
            app.sync_discrete_input_addresses(&range);
            app.sync_holding_reg_addresses(&range);
            app.sync_input_reg_addresses(&range);
        }
        let server = AsyncTcpServer::bind("127.0.0.1:0", unit).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let shared_ref = Arc::clone(&shared);
        tokio::spawn(async move {
            loop {
                match server.accept().await {
                    Ok((mut session, _)) => {
                        let mut app = Arc::clone(&shared_ref);
                        tokio::spawn(async move {
                            let _ = session.run(&mut app).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        });
        (port, shared)
    }

    #[tokio::test]
    async fn tcp_coil_write_single_and_read() {
        let (port, _app) = spawn_test_server().await;
        let client = AsyncTcpClient::new("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        // All coils start false
        let coils = client.read_multiple_coils(UID, 0, 4).await.unwrap();
        for addr in coils.from_address()..coils.from_address() + coils.quantity() {
            assert!(!coils.value(addr).unwrap(), "coil {addr} should initially be false");
        }

        // Write coil 2 = true
        let (addr, val) = client.write_single_coil(UID, 2, true).await.unwrap();
        assert_eq!(addr, 2);
        assert!(val);

        // Read back and verify only coil 2 changed
        let coils = client.read_multiple_coils(UID, 0, 4).await.unwrap();
        assert!(!coils.value(0).unwrap());
        assert!(!coils.value(1).unwrap());
        assert!(coils.value(2).unwrap(), "coil 2 should be true");
        assert!(!coils.value(3).unwrap());
    }

    #[tokio::test]
    async fn tcp_holding_reg_write_single_and_read() {
        let (port, _app) = spawn_test_server().await;
        let client = AsyncTcpClient::new("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        // All regs start at 0
        let regs = client.read_holding_registers(UID, 0, 4).await.unwrap();
        for addr in regs.from_address()..regs.from_address() + regs.quantity() {
            assert_eq!(regs.value(addr).unwrap(), 0);
        }

        // Write single register
        let (addr, val) = client.write_single_register(UID, 5, 0xABCD).await.unwrap();
        assert_eq!(addr, 5);
        assert_eq!(val, 0xABCD);

        // Read back
        let regs = client.read_holding_registers(UID, 5, 1).await.unwrap();
        assert_eq!(regs.value(5).unwrap(), 0xABCD);
    }

    #[tokio::test]
    async fn tcp_write_multiple_registers_and_read() {
        let (port, _app) = spawn_test_server().await;
        let client = AsyncTcpClient::new("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        let (start, qty) = client
            .write_multiple_registers(UID, 10, &[0x1234, 0x5678, 0x9ABC])
            .await
            .unwrap();
        assert_eq!(start, 10);
        assert_eq!(qty, 3);

        let regs = client.read_holding_registers(UID, 10, 3).await.unwrap();
        assert_eq!(regs.value(10).unwrap(), 0x1234);
        assert_eq!(regs.value(11).unwrap(), 0x5678);
        assert_eq!(regs.value(12).unwrap(), 0x9ABC);
    }

    #[tokio::test]
    async fn tcp_discrete_inputs_and_input_regs_initial_zero() {
        let (port, _app) = spawn_test_server().await;
        let client = AsyncTcpClient::new("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        let di = client.read_discrete_inputs(UID, 0, 4).await.unwrap();
        for addr in di.from_address()..di.from_address() + di.quantity() {
            assert!(!di.value(addr).unwrap(), "discrete input {addr} should be false");
        }

        let ir = client.read_input_registers(UID, 0, 4).await.unwrap();
        for addr in ir.from_address()..ir.from_address() + ir.quantity() {
            assert_eq!(ir.value(addr).unwrap(), 0, "input reg {addr} should be zero");
        }
    }

    #[tokio::test]
    async fn tcp_mask_write_register() {
        let (port, app) = spawn_test_server().await;
        // Set holding_reg[7] = 0xF0F0 via the shared store (also registers the address)
        app.lock().await.set_holding_reg(7, 0xF0F0);

        let client = AsyncTcpClient::new("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        // and=0xFF00 keeps upper byte; or=0x00AA sets lower bits
        // result = (0xF0F0 & 0xFF00) | (0x00AA & 0x00FF) = 0xF000 | 0x00AA = 0xF0AA
        client
            .mask_write_register(UID, 7, 0xFF00, 0x00AA)
            .await
            .unwrap();

        let regs = client.read_holding_registers(UID, 7, 1).await.unwrap();
        assert_eq!(regs.value(7).unwrap(), 0xF0AA);
    }

    #[tokio::test]
    async fn tcp_read_write_multiple_registers() {
        let (port, _app) = spawn_test_server().await;
        let client = AsyncTcpClient::new("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        // Write [0xDEAD, 0xBEEF] to addr 50 and simultaneously read 2 from addr 50
        let result = client
            .read_write_multiple_registers(UID, 50, 2, 50, &[0xDEAD, 0xBEEF])
            .await
            .unwrap();
        // Write happens first (Modbus spec), so the read sees the just-written values
        assert_eq!(result.value(50).unwrap(), 0xDEAD);
        assert_eq!(result.value(51).unwrap(), 0xBEEF);
    }
}
