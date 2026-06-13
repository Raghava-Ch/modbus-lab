use std::collections::BTreeMap;
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
use modbus_rs::{heapless::Vec as HeaplessVec, MAX_ADU_FRAME_LEN};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADDR_SPACE: usize = 65_536;
/// Max coils per Modbus PDU (2000 coils = 250 packed bytes).
const MAX_COIL_BYTES: usize = 250;
/// Max registers per Modbus PDU (125 × 2 bytes = 250).
const MAX_REG_WORDS: usize = 125;
const IBUS_REGION_START: u16 = 9000;
const IBUS_REGION_END: u16 = 9999;

// ── FC11 / FC2B ReportServerId: identifying the simulator ────────────────────
const SERVER_ID_STRING: &[u8] = b"ModbusLab Server";
const RUN_INDICATOR_ON: u8 = 0xFF;
const RUN_INDICATOR_OFF: u8 = 0x00;

// ── FC0C GetCommEventLog: keep a small ring of recent events ─────────────────
const COMM_EVENT_LOG_CAP: usize = 64;

// ── FC08 Diagnostics sub-functions (Modbus Application Protocol §6.8) ───────
mod diag_subfn {
    pub const RETURN_QUERY_DATA: u16 = 0x0000;
    pub const RESTART_COMMS_OPTION: u16 = 0x0001;
    pub const RETURN_DIAG_REGISTER: u16 = 0x0002;
    pub const CHANGE_ASCII_INPUT_DELIMITER: u16 = 0x0003;
    pub const FORCE_LISTEN_ONLY_MODE: u16 = 0x0004;
    pub const CLEAR_COUNTERS_AND_DIAG_REG: u16 = 0x000A;
    pub const RETURN_BUS_MESSAGE_COUNT: u16 = 0x000B;
    pub const RETURN_BUS_COMM_ERROR_COUNT: u16 = 0x000C;
    pub const RETURN_BUS_EXCEPTION_ERROR_COUNT: u16 = 0x000D;
    pub const RETURN_SERVER_MESSAGE_COUNT: u16 = 0x000E;
    pub const RETURN_SERVER_NO_RESPONSE_COUNT: u16 = 0x000F;
    pub const RETURN_SERVER_NAK_COUNT: u16 = 0x0010;
    pub const RETURN_SERVER_BUSY_COUNT: u16 = 0x0011;
    pub const RETURN_BUS_CHARACTER_OVERRUN_COUNT: u16 = 0x0012;
    pub const CLEAR_OVERRUN_COUNTER_AND_FLAG: u16 = 0x0014;
}

const DEVICE_ID_CONFORMITY_LEVEL: u8 = 0x01;

fn device_id_object_value(object_id: u8) -> Option<&'static str> {
    match object_id {
        0 => Some("Modbus Lab"),
        1 => Some("MBL-SERVER"),
        2 => Some("0.0.7"),
        3 => Some("https://github.com/Raghava-Ch/modbus-lab"),
        4 => Some("Modbus Lab Server"),
        5 => Some("Rust+Tauri"),
        6 => Some("Server Diagnostics"),
        _ => None,
    }
}

fn collect_device_id_object_ids(
    read_device_id_code: u8,
    object_id: u8,
) -> Result<[u8; 7], ExceptionCode> {
    match read_device_id_code {
        // Basic
        1 => Ok([0, 1, 2, 255, 255, 255, 255]),
        // Regular / Extended
        2 | 3 => Ok([0, 1, 2, 3, 4, 5, 6]),
        // Individual
        4 => {
            if device_id_object_value(object_id).is_some() {
                Ok([object_id, 255, 255, 255, 255, 255, 255])
            } else {
                Err(ExceptionCode::IllegalDataAddress)
            }
        }
        _ => Err(ExceptionCode::IllegalDataValue),
    }
}

fn encode_device_id_objects(
    read_device_id_code: u8,
    object_id: u8,
) -> Result<HeaplessVec<u8, MAX_ADU_FRAME_LEN>, ExceptionCode> {
    let ids = collect_device_id_object_ids(read_device_id_code, object_id)?;
    let mut encoded: HeaplessVec<u8, MAX_ADU_FRAME_LEN> = HeaplessVec::new();

    for id in ids {
        if id == 255 {
            continue;
        }

        let value = match device_id_object_value(id) {
            Some(v) => v,
            None => return Err(ExceptionCode::IllegalDataAddress),
        };

        let value_bytes = value.as_bytes();
        if value_bytes.len() > u8::MAX as usize {
            return Err(ExceptionCode::IllegalDataValue);
        }

        encoded
            .push(id)
            .map_err(|_| ExceptionCode::IllegalDataValue)?;
        encoded
            .push(value_bytes.len() as u8)
            .map_err(|_| ExceptionCode::IllegalDataValue)?;
        for byte in value_bytes {
            encoded
                .push(*byte)
                .map_err(|_| ExceptionCode::IllegalDataValue)?;
        }
    }

    Ok(encoded)
}

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
    fifo_queues: BTreeMap<u16, Vec<u16>>,
    file_records: BTreeMap<(u16, u16), Vec<u16>>,
    registered_coils: Vec<bool>,
    registered_discrete_inputs: Vec<bool>,
    registered_holding_regs: Vec<bool>,
    registered_input_regs: Vec<bool>,
    /// FC07 Read Exception Status — 8-bit user-defined status byte.
    exception_status: u8,
    /// FC08 / FC0B / FC0C diagnostic counters.
    bus_message_count: u16,
    bus_comm_error_count: u16,
    bus_exception_error_count: u16,
    server_message_count: u16,
    server_no_response_count: u16,
    server_nak_count: u16,
    server_busy_count: u16,
    bus_character_overrun_count: u16,
    diag_register: u16,
    /// FC0B Get Comm Event Counter — number of completed commands.
    comm_event_count: u16,
    /// FC0C Get Comm Event Log — most-recent-first ring buffer of event bytes.
    comm_events: Vec<u8>,
    /// FC08 sub-function 0x04 — Force Listen Only Mode.
    /// While true, all incoming requests are processed but suppressed (no response).
    listen_only_mode: bool,
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
            fifo_queues: BTreeMap::new(),
            file_records: BTreeMap::new(),
            registered_coils: vec![false; ADDR_SPACE],
            registered_discrete_inputs: vec![false; ADDR_SPACE],
            registered_holding_regs: vec![false; ADDR_SPACE],
            registered_input_regs: vec![false; ADDR_SPACE],
            exception_status: 0,
            bus_message_count: 0,
            bus_comm_error_count: 0,
            bus_exception_error_count: 0,
            server_message_count: 0,
            server_no_response_count: 0,
            server_nak_count: 0,
            server_busy_count: 0,
            bus_character_overrun_count: 0,
            diag_register: 0,
            comm_event_count: 0,
            comm_events: Vec::with_capacity(COMM_EVENT_LOG_CAP),
            listen_only_mode: false,
            traffic_sink,
        }
    }

    // ── Diagnostics counters helpers ─────────────────────────────────────────

    /// Push a Modbus event byte onto the comm-event log (most-recent first).
    fn push_comm_event(&mut self, event: u8) {
        if self.comm_events.len() == COMM_EVENT_LOG_CAP {
            self.comm_events.pop();
        }
        self.comm_events.insert(0, event);
    }

    /// Clear all diagnostic counters and the diagnostic register (sub-fn 0x000A).
    fn clear_all_counters(&mut self) {
        self.bus_message_count = 0;
        self.bus_comm_error_count = 0;
        self.bus_exception_error_count = 0;
        self.server_message_count = 0;
        self.server_no_response_count = 0;
        self.server_nak_count = 0;
        self.server_busy_count = 0;
        self.bus_character_overrun_count = 0;
        self.diag_register = 0;
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
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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

    /// True if `address` is currently registered as an application HR.
    /// Used by the iBus overlap-check to warn when iBus would mask an app reg.
    pub fn is_holding_reg_registered(&self, address: u16) -> bool {
        let idx = address as usize;
        idx < ADDR_SPACE && self.registered_holding_regs[idx]
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
    #[allow(dead_code)]
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

    // ── Store-read accessors (for server UI Option A polling) ─────────────────

    /// Read current coil values for the given addresses directly from the store.
    /// Returns the current value (false for unregistered/out-of-range addresses).
    pub fn get_coil_values(&self, addresses: &[u16]) -> Vec<(u16, bool)> {
        addresses
            .iter()
            .map(|&addr| {
                let idx = addr as usize;
                let value = if idx < ADDR_SPACE {
                    self.coils[idx]
                } else {
                    false
                };
                (addr, value)
            })
            .collect()
    }

    /// Read current discrete input values for the given addresses from the store.
    pub fn get_discrete_input_values(&self, addresses: &[u16]) -> Vec<(u16, bool)> {
        addresses
            .iter()
            .map(|&addr| {
                let idx = addr as usize;
                let value = if idx < ADDR_SPACE {
                    self.discrete_inputs[idx]
                } else {
                    false
                };
                (addr, value)
            })
            .collect()
    }

    /// Read current holding register values for the given addresses from the store.
    pub fn get_holding_reg_values(&self, addresses: &[u16]) -> Vec<(u16, u16)> {
        addresses
            .iter()
            .map(|&addr| {
                let idx = addr as usize;
                let value = if idx < ADDR_SPACE {
                    self.holding_regs[idx]
                } else {
                    0
                };
                (addr, value)
            })
            .collect()
    }

    // ── FIFO queue store accessors ───────────────────────────────────────────

    /// Store a FIFO queue payload for an address.
    pub fn set_fifo_queue(&mut self, address: u16, values: &[u16]) {
        const MAX_FIFO_VALUES: usize = 31;
        let mut next = values.to_vec();
        if next.len() > MAX_FIFO_VALUES {
            next.truncate(MAX_FIFO_VALUES);
        }
        self.fifo_queues.insert(address, next);
    }

    /// Append a single FIFO queue value for an address, dropping the oldest sample when full.
    pub fn append_fifo_queue_value(&mut self, address: u16, value: u16) -> Vec<u16> {
        const MAX_FIFO_VALUES: usize = 31;
        let queue = self.fifo_queues.entry(address).or_default();
        queue.push(value);
        if queue.len() > MAX_FIFO_VALUES {
            let overflow = queue.len() - MAX_FIFO_VALUES;
            queue.drain(0..overflow);
        }
        queue.clone()
    }

    /// Clear a FIFO queue payload for an address.
    pub fn clear_fifo_queue(&mut self, address: u16) {
        self.fifo_queues.remove(&address);
    }

    /// Read a FIFO queue snapshot for an address.
    pub fn get_fifo_queue(&self, address: u16) -> (u16, Vec<u16>) {
        match self.fifo_queues.get(&address) {
            Some(values) => (values.len() as u16, values.clone()),
            None => (0, Vec::new()),
        }
    }

    // ── File record store accessors ───────────────────────────────────────

    /// Store a file-record payload for (file_number, record_number).
    pub fn set_file_record(&mut self, file_number: u16, record_number: u16, values: &[u16]) {
        self.file_records
            .insert((file_number, record_number), values.to_vec());
    }

    /// Read up to `word_count` words for a file-record tuple, zero-filling missing values.
    pub fn get_file_record(
        &self,
        file_number: u16,
        record_number: u16,
        word_count: u16,
    ) -> Vec<u16> {
        let needed = word_count as usize;
        let mut out = vec![0_u16; needed];
        if let Some(values) = self.file_records.get(&(file_number, record_number)) {
            for (idx, value) in values.iter().copied().take(needed).enumerate() {
                out[idx] = value;
            }
        }
        out
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
        // Bookkeeping for FC08 / FC0B / FC0C diagnostic counters.
        self.bus_message_count = self.bus_message_count.wrapping_add(1);
        self.server_message_count = self.server_message_count.wrapping_add(1);
        // Record the function code byte in the comm-event log (Modbus spec
        // event byte: bit7=Receive Event, low nibble = exception/info bits;
        // we use the raw FC byte for simplicity, which is acceptable per spec
        // §6.13 "Communication Event Log").
        let fc_byte_for_event = req.function_code_byte();
        self.push_comm_event(fc_byte_for_event);

        // Listen-Only Mode (FC08 sub-function 0x04): all requests are still
        // processed for counters, but no response is transmitted.
        let suppress_response = self.listen_only_mode;

        let response = self.dispatch(req).await;

        // Track success vs. exception for FC0B comm-event-counter semantics:
        // increment only on a successful (non-exception) response.
        match &response {
            ModbusResponse::Exception { .. } => {
                self.bus_exception_error_count = self.bus_exception_error_count.wrapping_add(1);
            }
            ModbusResponse::NoResponse => {
                self.server_no_response_count = self.server_no_response_count.wrapping_add(1);
            }
            _ => {
                self.comm_event_count = self.comm_event_count.wrapping_add(1);
            }
        }

        if suppress_response {
            return ModbusResponse::NoResponse;
        }
        response
    }
}

impl ServerApp {
    async fn dispatch(&mut self, req: ModbusRequest) -> ModbusResponse {
        match req {
            // ── FC01: Read Coils ──────────────────────────────────────────────
            ModbusRequest::ReadCoils { address, count, .. } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE || self.registered_coils[start..end].iter().any(|&r| !r) {
                    return ModbusResponse::exception(
                        FunctionCode::ReadCoils,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                let (buf, byte_count) = Self::pack_bools(&self.coils[start..end]);
                ModbusResponse::packed_bits(FunctionCode::ReadCoils, &buf[..byte_count])
            }

            // ── FC05: Write Single Coil ───────────────────────────────────────
            ModbusRequest::WriteSingleCoil { address, value, .. } => {
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
                if end > ADDR_SPACE || self.registered_coils[start..end].iter().any(|&r| !r) {
                    return ModbusResponse::exception(
                        FunctionCode::WriteMultipleCoils,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                Self::unpack_coils(&mut self.coils[start..end], &data);
                ModbusResponse::echo_multi_write(FunctionCode::WriteMultipleCoils, address, count)
            }

            // ── FC02: Read Discrete Inputs ────────────────────────────────────
            ModbusRequest::ReadDiscreteInputs { address, count, .. } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE
                    || self.registered_discrete_inputs[start..end]
                        .iter()
                        .any(|&r| !r)
                {
                    return ModbusResponse::exception(
                        FunctionCode::ReadDiscreteInputs,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                let (buf, byte_count) = Self::pack_bools(&self.discrete_inputs[start..end]);
                ModbusResponse::packed_bits(FunctionCode::ReadDiscreteInputs, &buf[..byte_count])
            }

            // ── FC03: Read Holding Registers ──────────────────────────────────
            ModbusRequest::ReadHoldingRegisters { address, count, .. } => {
                let start = address as usize;
                let end = start + count as usize;
                if end > ADDR_SPACE || count as usize > MAX_REG_WORDS {
                    return ModbusResponse::exception(
                        FunctionCode::ReadHoldingRegisters,
                        ExceptionCode::IllegalDataAddress,
                    );
                }

                // iBus overlay (if active) owns HR 9000..9999. Build a values
                // window that swaps in overlay-served words for any address in
                // the reserved region; everything else still requires the
                // application HR to be registered.
                let mut values: Vec<u16> = Vec::with_capacity(count as usize);
                for offset in 0..count as usize {
                    let addr = (start + offset) as u16;
                    if let Some(v) = crate::ibus::read_hr(addr) {
                        values.push(v);
                    } else if (IBUS_REGION_START..=IBUS_REGION_END).contains(&addr) {
                        // Reserved iBus space should remain readable as zero even
                        // when no descriptor is installed yet.
                        values.push(0);
                    } else {
                        // For non-iBus HR addresses, expose the memory table
                        // directly (default zero for never-written addresses).
                        values.push(self.holding_regs[start + offset]);
                    }
                }
                ModbusResponse::registers(FunctionCode::ReadHoldingRegisters, &values)
            }

            // ── FC06: Write Single Register ───────────────────────────────────
            ModbusRequest::WriteSingleRegister { address, value, .. } => {
                // iBus-owned HR region is read-only while overlay is active.
                // Return IllegalDataAddress so clients do not misinterpret a
                // dropped write as successful persistence.
                if crate::ibus::owns_hr(address) {
                    return ModbusResponse::exception(
                        FunctionCode::WriteSingleRegister,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                let idx = address as usize;
                if idx >= ADDR_SPACE {
                    return ModbusResponse::exception(
                        FunctionCode::WriteSingleRegister,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                self.holding_regs[idx] = value;
                self.registered_holding_regs[idx] = true;
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
                if end > ADDR_SPACE || count as usize > MAX_REG_WORDS {
                    return ModbusResponse::exception(
                        FunctionCode::WriteMultipleRegisters,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                // Reject writes to iBus-owned addresses (read-only tables).
                for offset in 0..count as usize {
                    let addr = (start + offset) as u16;
                    if crate::ibus::owns_hr(addr) {
                        return ModbusResponse::exception(
                            FunctionCode::WriteMultipleRegisters,
                            ExceptionCode::IllegalDataAddress,
                        );
                    }
                }
                // `data` is big-endian byte pairs; convert to u16 in-place.
                for i in 0..(count as usize) {
                    let hi = data[i * 2] as u16;
                    let lo = data[i * 2 + 1] as u16;
                    self.holding_regs[start + i] = (hi << 8) | lo;
                    self.registered_holding_regs[start + i] = true;
                }
                ModbusResponse::echo_multi_write(
                    FunctionCode::WriteMultipleRegisters,
                    address,
                    count,
                )
            }

            // ── FC04: Read Input Registers ────────────────────────────────────
            ModbusRequest::ReadInputRegisters { address, count, .. } => {
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

            // ── FC18: Read FIFO Queue ────────────────────────────────────────
            ModbusRequest::ReadFifoQueue {
                pointer_address, ..
            } => {
                let (fifo_count, values) = self.get_fifo_queue(pointer_address);
                if values.len() > 31 || fifo_count as usize != values.len() {
                    return ModbusResponse::exception(
                        FunctionCode::ReadFifoQueue,
                        ExceptionCode::IllegalDataValue,
                    );
                }

                let mut payload: HeaplessVec<u8, MAX_ADU_FRAME_LEN> = HeaplessVec::new();
                if payload
                    .extend_from_slice(&fifo_count.to_be_bytes())
                    .is_err()
                {
                    return ModbusResponse::exception(
                        FunctionCode::ReadFifoQueue,
                        ExceptionCode::ServerDeviceFailure,
                    );
                }
                for value in values {
                    if payload.extend_from_slice(&value.to_be_bytes()).is_err() {
                        return ModbusResponse::exception(
                            FunctionCode::ReadFifoQueue,
                            ExceptionCode::ServerDeviceFailure,
                        );
                    }
                }

                ModbusResponse::fifo_response(&payload)
            }

            // ── FC14: Read File Record ───────────────────────────────────────
            ModbusRequest::ReadFileRecord { sub_requests, .. } => {
                let mut payload: HeaplessVec<u8, MAX_ADU_FRAME_LEN> = HeaplessVec::new();

                for sub in sub_requests {
                    let values =
                        self.get_file_record(sub.file_number, sub.record_number, sub.record_length);
                    let data_len = 1 + values.len() * 2;
                    if data_len > u8::MAX as usize {
                        return ModbusResponse::exception(
                            FunctionCode::ReadFileRecord,
                            ExceptionCode::IllegalDataValue,
                        );
                    }

                    if payload.push(data_len as u8).is_err() || payload.push(0x06).is_err() {
                        return ModbusResponse::exception(
                            FunctionCode::ReadFileRecord,
                            ExceptionCode::ServerDeviceFailure,
                        );
                    }

                    for value in values {
                        let [hi, lo] = value.to_be_bytes();
                        if payload.push(hi).is_err() || payload.push(lo).is_err() {
                            return ModbusResponse::exception(
                                FunctionCode::ReadFileRecord,
                                ExceptionCode::ServerDeviceFailure,
                            );
                        }
                    }
                }

                ModbusResponse::read_file_record_response(payload.as_slice())
            }

            // ── FC15: Write File Record ──────────────────────────────────────
            ModbusRequest::WriteFileRecord {
                sub_requests,
                raw_pdu_data,
                ..
            } => {
                for sub in sub_requests {
                    let expected_len = sub.record_length as usize * 2;
                    if sub.record_data.len() != expected_len {
                        return ModbusResponse::exception(
                            FunctionCode::WriteFileRecord,
                            ExceptionCode::IllegalDataValue,
                        );
                    }

                    let mut words = Vec::with_capacity(sub.record_length as usize);
                    let bytes = sub.record_data.as_slice();
                    for chunk in bytes.chunks_exact(2) {
                        words.push(u16::from_be_bytes([chunk[0], chunk[1]]));
                    }

                    self.set_file_record(sub.file_number, sub.record_number, &words);
                }

                ModbusResponse::echo_write_file_record(raw_pdu_data)
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

            // ── FC2B/MEI 0x0E: Read Device Identification ───────────────────
            ModbusRequest::EncapsulatedInterfaceTransport { mei_type, data, .. } => {
                if mei_type != 0x0E {
                    return ModbusResponse::exception(
                        FunctionCode::EncapsulatedInterfaceTransport,
                        ExceptionCode::IllegalDataValue,
                    );
                }

                if data.len() < 2 {
                    return ModbusResponse::exception(
                        FunctionCode::EncapsulatedInterfaceTransport,
                        ExceptionCode::IllegalDataValue,
                    );
                }

                let read_device_id_code = data[0];
                let object_id = data[1];

                let objects = match encode_device_id_objects(read_device_id_code, object_id) {
                    Ok(v) => v,
                    Err(code) => {
                        return ModbusResponse::exception(
                            FunctionCode::EncapsulatedInterfaceTransport,
                            code,
                        );
                    }
                };
                ModbusResponse::ReadDeviceId {
                    read_device_id_code,
                    conformity_level: DEVICE_ID_CONFORMITY_LEVEL,
                    more_follows: false,
                    next_object_id: 0,
                    objects,
                }
            }

            // ── FC07: Read Exception Status ──────────────────────────────────
            ModbusRequest::ReadExceptionStatus { .. } => {
                ModbusResponse::read_exception_status(self.exception_status)
            }

            // ── FC08: Diagnostics ────────────────────────────────────────────
            ModbusRequest::Diagnostics {
                sub_function, data, ..
            } => {
                use diag_subfn::*;
                match sub_function {
                    RETURN_QUERY_DATA => ModbusResponse::diagnostics_echo(sub_function, data),
                    RESTART_COMMS_OPTION => {
                        // 0x0000 = leave log intact; 0xFF00 = clear log.
                        if data == 0xFF00 {
                            self.comm_events.clear();
                        }
                        self.listen_only_mode = false;
                        ModbusResponse::diagnostics_echo(sub_function, data)
                    }
                    RETURN_DIAG_REGISTER => {
                        ModbusResponse::diagnostics_echo(sub_function, self.diag_register)
                    }
                    CHANGE_ASCII_INPUT_DELIMITER => {
                        // Modbus serial-only feature; echo back as success.
                        ModbusResponse::diagnostics_echo(sub_function, data)
                    }
                    FORCE_LISTEN_ONLY_MODE => {
                        self.listen_only_mode = true;
                        ModbusResponse::NoResponse
                    }
                    CLEAR_COUNTERS_AND_DIAG_REG => {
                        self.clear_all_counters();
                        ModbusResponse::diagnostics_echo(sub_function, 0)
                    }
                    RETURN_BUS_MESSAGE_COUNT => {
                        ModbusResponse::diagnostics_echo(sub_function, self.bus_message_count)
                    }
                    RETURN_BUS_COMM_ERROR_COUNT => {
                        ModbusResponse::diagnostics_echo(sub_function, self.bus_comm_error_count)
                    }
                    RETURN_BUS_EXCEPTION_ERROR_COUNT => ModbusResponse::diagnostics_echo(
                        sub_function,
                        self.bus_exception_error_count,
                    ),
                    RETURN_SERVER_MESSAGE_COUNT => {
                        ModbusResponse::diagnostics_echo(sub_function, self.server_message_count)
                    }
                    RETURN_SERVER_NO_RESPONSE_COUNT => ModbusResponse::diagnostics_echo(
                        sub_function,
                        self.server_no_response_count,
                    ),
                    RETURN_SERVER_NAK_COUNT => {
                        ModbusResponse::diagnostics_echo(sub_function, self.server_nak_count)
                    }
                    RETURN_SERVER_BUSY_COUNT => {
                        ModbusResponse::diagnostics_echo(sub_function, self.server_busy_count)
                    }
                    RETURN_BUS_CHARACTER_OVERRUN_COUNT => ModbusResponse::diagnostics_echo(
                        sub_function,
                        self.bus_character_overrun_count,
                    ),
                    CLEAR_OVERRUN_COUNTER_AND_FLAG => {
                        self.bus_character_overrun_count = 0;
                        ModbusResponse::diagnostics_echo(sub_function, 0)
                    }
                    _ => ModbusResponse::exception(
                        FunctionCode::Diagnostics,
                        ExceptionCode::IllegalDataValue,
                    ),
                }
            }

            // ── FC0B: Get Comm Event Counter ─────────────────────────────────
            ModbusRequest::GetCommEventCounter { .. } => {
                // Status word: 0xFFFF = busy (previous request still running),
                // 0x0000 = ready. We're synchronous, so always ready.
                ModbusResponse::comm_event_counter(0x0000, self.comm_event_count)
            }

            // ── FC0C: Get Comm Event Log ─────────────────────────────────────
            ModbusRequest::GetCommEventLog { .. } => {
                // Payload: status(2) | event_count(2) | message_count(2) | events(N)
                // Cap events at MAX_ADU_FRAME_LEN minus the 6-byte fixed header.
                let max_events = COMM_EVENT_LOG_CAP.min(self.comm_events.len());
                let mut payload: Vec<u8> = Vec::with_capacity(6 + max_events);
                payload.extend_from_slice(&0x0000u16.to_be_bytes()); // status: ready
                payload.extend_from_slice(&self.comm_event_count.to_be_bytes());
                payload.extend_from_slice(&self.bus_message_count.to_be_bytes());
                payload.extend_from_slice(&self.comm_events[..max_events]);
                ModbusResponse::comm_event_log(&payload)
            }

            // ── FC11: Report Server ID ───────────────────────────────────────
            ModbusRequest::ReportServerId { .. } => {
                // Payload = server_id_string + run_indicator_status_byte
                let mut payload: Vec<u8> = Vec::with_capacity(SERVER_ID_STRING.len() + 1);
                payload.extend_from_slice(SERVER_ID_STRING);
                payload.push(if self.listen_only_mode {
                    RUN_INDICATOR_OFF
                } else {
                    RUN_INDICATOR_ON
                });
                ModbusResponse::report_server_id(&payload)
            }

            // ── All other FCs: reply with Illegal Function ────────────────────
            other => {
                let fc_byte = other.function_code_byte();
                let fc = FunctionCode::try_from(fc_byte).unwrap_or(FunctionCode::ReadCoils); // fallback; never reached for known FCs
                ModbusResponse::exception(fc, ExceptionCode::IllegalFunction)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

fn fmt_hex(b: &[u8]) -> String {
    b.iter()
        .map(|x| format!("{x:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
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
            matches!(
                resp,
                ModbusResponse::EchoCoil {
                    address: 3,
                    raw_value: 0xFF00
                }
            ),
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
    async fn unit_fc18_fifo_returns_configured_values() {
        let mut app = ServerApp::new(None);
        app.set_fifo_queue(0x0012, &[0x1111, 0x2222, 0x3333]);

        let resp = app
            .handle(ModbusRequest::ReadFifoQueue {
                txn_id: 1,
                unit: unit(),
                pointer_address: 0x0012,
            })
            .await;

        match resp {
            ModbusResponse::FifoData { data } => {
                assert_eq!(&data[0..2], &[0x00, 0x03]);
                assert_eq!(&data[2..4], &[0x11, 0x11]);
                assert_eq!(&data[4..6], &[0x22, 0x22]);
                assert_eq!(&data[6..8], &[0x33, 0x33]);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn unit_fc18_fifo_clear_returns_empty() {
        let mut app = ServerApp::new(None);
        app.set_fifo_queue(0x0020, &[1, 2]);
        app.clear_fifo_queue(0x0020);

        let resp = app
            .handle(ModbusRequest::ReadFifoQueue {
                txn_id: 1,
                unit: unit(),
                pointer_address: 0x0020,
            })
            .await;

        match resp {
            ModbusResponse::FifoData { data } => {
                assert_eq!(data.len(), 2);
                assert_eq!(&data[0..2], &[0x00, 0x00]);
            }
            other => panic!("unexpected: {other:?}"),
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
            matches!(
                resp,
                ModbusResponse::EchoRegister {
                    address: 10,
                    value: 0xABCD
                }
            ),
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
            assert!(
                !coils.value(addr).unwrap(),
                "coil {addr} should initially be false"
            );
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
            assert!(
                !di.value(addr).unwrap(),
                "discrete input {addr} should be false"
            );
        }

        let ir = client.read_input_registers(UID, 0, 4).await.unwrap();
        for addr in ir.from_address()..ir.from_address() + ir.quantity() {
            assert_eq!(
                ir.value(addr).unwrap(),
                0,
                "input reg {addr} should be zero"
            );
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
