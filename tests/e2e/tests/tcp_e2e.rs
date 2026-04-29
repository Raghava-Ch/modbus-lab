//! End-to-end Modbus TCP integration tests.
//!
//! Each test spins up a real `AsyncTcpServer` bound to port 0 (OS picks a free
//! port — no sleeps, no hard-coded port numbers) and connects a real
//! `AsyncTcpClient` to exercise the full TCP + Modbus PDU round-trip.
//!
//! The `TestServerApp` implemented here mirrors the production `ServerApp`
//! logic from `apps/server/src-tauri/src/modbus/listener_app.rs`:
//!   - addresses must be explicitly registered before they can be served;
//!   - unregistered addresses return `IllegalDataAddress`;
//!   - write operations mutate the in-memory store.
//!
//! No Tauri dependency is needed — only `modbus-rs` and `mbus-core`.

use std::collections::HashMap;

use mbus_core::errors::ExceptionCode;
use mbus_core::function_codes::public::FunctionCode;
use modbus_rs::mbus_async::server::{
    AsyncAppHandler, AsyncTrafficNotifier, ModbusRequest, ModbusResponse,
};
use modbus_rs::mbus_async::AsyncTcpClient;
use modbus_rs::mbus_async::server::AsyncTcpServer;
use modbus_rs::UnitIdOrSlaveAddr;
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// TestServerApp
// ---------------------------------------------------------------------------

/// Minimal Modbus server application for E2E tests.
///
/// Mirrors the production `ServerApp` pattern:
/// - addresses are registered explicitly before they can be read/written;
/// - unregistered addresses return `IllegalDataAddress`.
struct TestServerApp {
    coils: HashMap<u16, bool>,
    discrete_inputs: HashMap<u16, bool>,
    holding_regs: HashMap<u16, u16>,
    input_regs: HashMap<u16, u16>,
}

impl TestServerApp {
    fn new() -> Self {
        Self {
            coils: HashMap::new(),
            discrete_inputs: HashMap::new(),
            holding_regs: HashMap::new(),
            input_regs: HashMap::new(),
        }
    }

    fn set_coil(&mut self, address: u16, value: bool) {
        self.coils.insert(address, value);
    }

    fn set_discrete_input(&mut self, address: u16, value: bool) {
        self.discrete_inputs.insert(address, value);
    }

    fn set_holding_reg(&mut self, address: u16, value: u16) {
        self.holding_regs.insert(address, value);
    }

    fn set_input_reg(&mut self, address: u16, value: u16) {
        self.input_regs.insert(address, value);
    }

    // ── Pack bools for FC01/FC02 response ───────────────────────────────────

    fn pack_bools(src: &[bool]) -> Vec<u8> {
        let byte_count = (src.len() + 7) / 8;
        let mut buf = vec![0u8; byte_count];
        for (i, &v) in src.iter().enumerate() {
            if v {
                buf[i / 8] |= 1 << (i % 8);
            }
        }
        buf
    }
}

impl AsyncTrafficNotifier for TestServerApp {}

impl AsyncAppHandler for TestServerApp {
    async fn handle(&mut self, req: ModbusRequest) -> ModbusResponse {
        match req {
            // ── FC01: Read Coils ─────────────────────────────────────────────
            ModbusRequest::ReadCoils { address, count, .. } => {
                let values: Option<Vec<bool>> = (0..count as u16)
                    .map(|i| self.coils.get(&(address + i)).copied())
                    .collect();
                match values {
                    None => ModbusResponse::exception(
                        FunctionCode::ReadCoils,
                        ExceptionCode::IllegalDataAddress,
                    ),
                    Some(bits) => {
                        let buf = Self::pack_bools(&bits);
                        ModbusResponse::packed_bits(FunctionCode::ReadCoils, &buf)
                    }
                }
            }

            // ── FC05: Write Single Coil ──────────────────────────────────────
            ModbusRequest::WriteSingleCoil { address, value, .. } => {
                if !self.coils.contains_key(&address) {
                    return ModbusResponse::exception(
                        FunctionCode::WriteSingleCoil,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                self.coils.insert(address, value);
                ModbusResponse::echo_coil(address, value)
            }

            // ── FC02: Read Discrete Inputs ───────────────────────────────────
            ModbusRequest::ReadDiscreteInputs { address, count, .. } => {
                let values: Option<Vec<bool>> = (0..count as u16)
                    .map(|i| self.discrete_inputs.get(&(address + i)).copied())
                    .collect();
                match values {
                    None => ModbusResponse::exception(
                        FunctionCode::ReadDiscreteInputs,
                        ExceptionCode::IllegalDataAddress,
                    ),
                    Some(bits) => {
                        let buf = Self::pack_bools(&bits);
                        ModbusResponse::packed_bits(FunctionCode::ReadDiscreteInputs, &buf)
                    }
                }
            }

            // ── FC03: Read Holding Registers ─────────────────────────────────
            ModbusRequest::ReadHoldingRegisters { address, count, .. } => {
                let values: Option<Vec<u16>> = (0..count as u16)
                    .map(|i| self.holding_regs.get(&(address + i)).copied())
                    .collect();
                match values {
                    None => ModbusResponse::exception(
                        FunctionCode::ReadHoldingRegisters,
                        ExceptionCode::IllegalDataAddress,
                    ),
                    Some(regs) => {
                        ModbusResponse::registers(FunctionCode::ReadHoldingRegisters, &regs)
                    }
                }
            }

            // ── FC06: Write Single Register ──────────────────────────────────
            ModbusRequest::WriteSingleRegister { address, value, .. } => {
                if !self.holding_regs.contains_key(&address) {
                    return ModbusResponse::exception(
                        FunctionCode::WriteSingleRegister,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                self.holding_regs.insert(address, value);
                ModbusResponse::echo_register(address, value)
            }

            // ── FC04: Read Input Registers ───────────────────────────────────
            ModbusRequest::ReadInputRegisters { address, count, .. } => {
                let values: Option<Vec<u16>> = (0..count as u16)
                    .map(|i| self.input_regs.get(&(address + i)).copied())
                    .collect();
                match values {
                    None => ModbusResponse::exception(
                        FunctionCode::ReadInputRegisters,
                        ExceptionCode::IllegalDataAddress,
                    ),
                    Some(regs) => {
                        ModbusResponse::registers(FunctionCode::ReadInputRegisters, &regs)
                    }
                }
            }

            // ── All other FCs: not implemented in test server ────────────────
            _ => ModbusResponse::exception(
                FunctionCode::ReadCoils, // placeholder FC; library ignores it for exceptions
                ExceptionCode::IllegalFunction,
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// Bind an `AsyncTcpServer` to port 0 (OS-assigned), accept exactly one TCP
/// connection, run it to completion, then send the final server state back via
/// a oneshot channel.
///
/// Returns `(port, state_rx)`.  The caller connects a client, runs assertions,
/// drops the client (which closes the TCP connection), then awaits `state_rx`
/// to verify the server-side state after writes.
async fn setup_server(mut app: TestServerApp) -> (u16, oneshot::Receiver<TestServerApp>) {
    let unit = UnitIdOrSlaveAddr::try_from(1u8).expect("unit id 1 is always valid");
    let server = AsyncTcpServer::bind("127.0.0.1:0", unit)
        .await
        .expect("bind to port 0 must succeed");
    let port = server
        .local_addr()
        .expect("local_addr after bind must succeed")
        .port();

    let (tx, rx) = oneshot::channel::<TestServerApp>();

    tokio::spawn(async move {
        // Accept exactly one connection — sufficient for all our test scenarios.
        match server.accept().await {
            Ok((mut session, _peer)) => {
                let _ = session.run(&mut app).await;
            }
            Err(e) => eprintln!("[test-server] accept error: {e:?}"),
        }
        // Send the final state back so the test can assert post-write values.
        let _ = tx.send(app);
    });

    (port, rx)
}

/// Create an `AsyncTcpClient`, connect it to `127.0.0.1:port`, and return it
/// ready for use.  The const generic `D = 32` matches the production pipeline
/// depth used in the client app's `service.rs`.
async fn connect_client(port: u16) -> AsyncTcpClient<32> {
    let client = AsyncTcpClient::<32>::new_with_pipeline("127.0.0.1", port)
        .expect("client construction must succeed");
    client
        .connect()
        .await
        .expect("TCP connect to 127.0.0.1 must succeed");
    client
}

/// Wait for the server task to finish (after the client disconnects) with a
/// generous 5-second ceiling so flaky CI machines never block forever.
async fn drain_server(rx: oneshot::Receiver<TestServerApp>) -> TestServerApp {
    tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .expect("server task must complete within 5 s")
        .expect("server state channel must not be dropped")
}

// ---------------------------------------------------------------------------
// TC01 — Read holding registers preset on the server
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc01_read_holding_registers() {
    let mut app = TestServerApp::new();
    app.set_holding_reg(10, 42);
    app.set_holding_reg(11, 100);

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    let regs = client
        .read_holding_registers(1, 10, 2)
        .await
        .expect("read holding registers must succeed");
    let start = regs.from_address();
    let values: Vec<u16> = (0..regs.quantity())
        .map(|i| regs.value(start + i).expect("address within block"))
        .collect();
    assert_eq!(values, [42, 100], "holding register values must match preset");

    drop(client);
    drain_server(state_rx).await;
}

// ---------------------------------------------------------------------------
// TC02 — Write a holding register and verify server-side state
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc02_write_single_register_persists() {
    let mut app = TestServerApp::new();
    app.set_holding_reg(20, 0); // register 20 must be registered before writing

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    client
        .write_single_register(1, 20, 9999)
        .await
        .expect("write single register must succeed");

    drop(client);
    let final_state = drain_server(state_rx).await;

    assert_eq!(
        final_state.holding_regs[&20], 9999,
        "server-side register must reflect the written value"
    );
}

// ---------------------------------------------------------------------------
// TC03 — Read coils preset on the server
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc03_read_coils() {
    let mut app = TestServerApp::new();
    app.set_coil(0, true);
    app.set_coil(1, false);
    app.set_coil(2, true);

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    let coils = client
        .read_multiple_coils(1, 0, 3)
        .await
        .expect("read coils must succeed");
    let start = coils.from_address();
    let bits: Vec<bool> = (0..coils.quantity())
        .map(|i| coils.value(start + i).expect("address within block"))
        .collect();
    assert_eq!(bits, [true, false, true], "coil values must match preset");

    drop(client);
    drain_server(state_rx).await;
}

// ---------------------------------------------------------------------------
// TC04 — Write a coil and verify server-side state
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc04_write_single_coil_persists() {
    let mut app = TestServerApp::new();
    app.set_coil(5, false); // register coil 5 as initially false

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    client
        .write_single_coil(1, 5, true)
        .await
        .expect("write single coil must succeed");

    drop(client);
    let final_state = drain_server(state_rx).await;

    assert_eq!(
        final_state.coils[&5], true,
        "server-side coil must reflect the written value"
    );
}

// ---------------------------------------------------------------------------
// TC05 — Read discrete inputs preset on the server
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc05_read_discrete_inputs() {
    let mut app = TestServerApp::new();
    app.set_discrete_input(100, false);
    app.set_discrete_input(101, true);

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    let inputs = client
        .read_discrete_inputs(1, 100, 2)
        .await
        .expect("read discrete inputs must succeed");
    let start = inputs.from_address();
    let bits: Vec<bool> = (0..inputs.quantity())
        .map(|i| inputs.value(start + i).expect("address within block"))
        .collect();
    assert_eq!(bits, [false, true], "discrete input values must match preset");

    drop(client);
    drain_server(state_rx).await;
}

// ---------------------------------------------------------------------------
// TC06 — Read input registers preset on the server
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc06_read_input_registers() {
    let mut app = TestServerApp::new();
    app.set_input_reg(200, 1234);
    app.set_input_reg(201, 5678);

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    let regs = client
        .read_input_registers(1, 200, 2)
        .await
        .expect("read input registers must succeed");
    let start = regs.from_address();
    let values: Vec<u16> = (0..regs.quantity())
        .map(|i| regs.value(start + i).expect("address within block"))
        .collect();
    assert_eq!(values, [1234, 5678], "input register values must match preset");

    drop(client);
    drain_server(state_rx).await;
}

// ---------------------------------------------------------------------------
// TC07 — Reading an unregistered address must return an exception
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc07_unregistered_address_returns_exception() {
    // Deliberately register nothing — every read should fail.
    let app = TestServerApp::new();

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    let result = client.read_holding_registers(1, 0, 1).await;
    assert!(
        result.is_err(),
        "reading an unregistered address must return an error"
    );
    let err_msg = result.unwrap_err().to_string();
    // The Modbus exception code must be present in the error description.
    assert!(
        err_msg.to_lowercase().contains("illegal")
            || err_msg.contains("0x02") // IllegalDataAddress exception byte
            || err_msg.contains("2"),
        "error must indicate an illegal-data-address exception, got: {err_msg}"
    );

    drop(client);
    drain_server(state_rx).await;
}

// ---------------------------------------------------------------------------
// TC08 — Write a register then immediately read it back in the same session
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc08_write_then_read_back() {
    let mut app = TestServerApp::new();
    app.set_holding_reg(30, 0);

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    // Write first.
    client
        .write_single_register(1, 30, 7777)
        .await
        .expect("write must succeed");

    // Read back in the same TCP session — must return the updated value.
    let regs = client
        .read_holding_registers(1, 30, 1)
        .await
        .expect("read after write must succeed");
    let values: Vec<u16> = (0..regs.quantity())
        .map(|i| regs.value(regs.from_address() + i).expect("address within block"))
        .collect();
    assert_eq!(values, [7777], "read-back must return the just-written value");

    drop(client);
    drain_server(state_rx).await;
}
