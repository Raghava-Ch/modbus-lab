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

            // ── FC0F: Write Multiple Coils ───────────────────────────────────
            ModbusRequest::WriteMultipleCoils {
                address,
                count,
                data,
                ..
            } => {
                // First check every target address is registered.
                let all_registered = (0..count as u16)
                    .all(|i| self.coils.contains_key(&(address + i)));
                if !all_registered {
                    return ModbusResponse::exception(
                        FunctionCode::WriteMultipleCoils,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                // `data` is packed LSB-first; same encoding as production server.
                for i in 0..count as usize {
                    let bit = (data[i / 8] >> (i % 8)) & 1 != 0;
                    self.coils.insert(address + i as u16, bit);
                }
                ModbusResponse::echo_multi_write(
                    FunctionCode::WriteMultipleCoils,
                    address,
                    count,
                )
            }

            // ── FC10: Write Multiple Registers ───────────────────────────────
            ModbusRequest::WriteMultipleRegisters {
                address,
                count,
                data,
                ..
            } => {
                let all_registered = (0..count as u16)
                    .all(|i| self.holding_regs.contains_key(&(address + i)));
                if !all_registered {
                    return ModbusResponse::exception(
                        FunctionCode::WriteMultipleRegisters,
                        ExceptionCode::IllegalDataAddress,
                    );
                }
                // `data` is big-endian byte pairs (production layout — see
                // apps/server/src-tauri/src/modbus/listener_app.rs:598-602).
                for i in 0..count as usize {
                    let hi = data[i * 2] as u16;
                    let lo = data[i * 2 + 1] as u16;
                    self.holding_regs.insert(address + i as u16, (hi << 8) | lo);
                }
                ModbusResponse::echo_multi_write(
                    FunctionCode::WriteMultipleRegisters,
                    address,
                    count,
                )
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

/// Variant of `setup_server` that accepts `n_connections` sequentially, running
/// each session to completion before accepting the next.  The shared `app`
/// state persists across sessions, so a write from session N is visible in a
/// read from session N+1.  The final state is returned via the oneshot channel
/// after the Nth session ends.
async fn setup_multi_session_server(
    mut app: TestServerApp,
    n_connections: usize,
) -> (u16, oneshot::Receiver<TestServerApp>) {
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
        for _ in 0..n_connections {
            match server.accept().await {
                Ok((mut session, _peer)) => {
                    let _ = session.run(&mut app).await;
                }
                Err(e) => {
                    eprintln!("[test-server] accept error: {e:?}");
                    break;
                }
            }
        }
        let _ = tx.send(app);
    });

    (port, rx)
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

// ---------------------------------------------------------------------------
// TC09 — FC0F: Write Multiple Coils
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc09_write_multiple_coils() {
    let mut app = TestServerApp::new();
    // Pre-register coils 0..=7 as false.
    for addr in 0..8u16 {
        app.set_coil(addr, false);
    }

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    // Build a Coils payload: addresses 0..8 = [T,F,T,F,T,F,T,F]
    let mut coils = mbus_core::models::coil::Coils::new(0, 8).expect("valid block");
    for (i, &v) in [true, false, true, false, true, false, true, false].iter().enumerate() {
        coils.set_value(i as u16, v).expect("set within block");
    }

    let (echoed_addr, echoed_qty) = client
        .write_multiple_coils(1, 0, &coils)
        .await
        .expect("write multiple coils must succeed");
    assert_eq!((echoed_addr, echoed_qty), (0, 8));

    drop(client);
    let final_state = drain_server(state_rx).await;

    let observed: Vec<bool> = (0..8u16).map(|a| final_state.coils[&a]).collect();
    assert_eq!(
        observed,
        vec![true, false, true, false, true, false, true, false],
        "all 8 coils must reflect the bulk-written values"
    );
}

// ---------------------------------------------------------------------------
// TC10 — FC10: Write Multiple Registers
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc10_write_multiple_registers() {
    let mut app = TestServerApp::new();
    for addr in 100..104u16 {
        app.set_holding_reg(addr, 0);
    }

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    let values = [0x1111u16, 0x2222, 0x3333, 0x4444];
    let (echoed_addr, echoed_qty) = client
        .write_multiple_registers(1, 100, &values)
        .await
        .expect("write multiple registers must succeed");
    assert_eq!((echoed_addr, echoed_qty), (100, 4));

    drop(client);
    let final_state = drain_server(state_rx).await;

    let observed: Vec<u16> = (100..104u16).map(|a| final_state.holding_regs[&a]).collect();
    assert_eq!(observed, values, "all 4 registers must reflect bulk-written values");
}

// ---------------------------------------------------------------------------
// TC11 — Multi-session: server accepts multiple sequential client connections
// and state persists across sessions.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc11_multi_session_state_persists() {
    let mut app = TestServerApp::new();
    app.set_holding_reg(50, 0);

    let (port, state_rx) = setup_multi_session_server(app, 2).await;

    // Session 1: write a value, then disconnect.
    {
        let client = connect_client(port).await;
        client
            .write_single_register(1, 50, 4242)
            .await
            .expect("session-1 write must succeed");
        // Drop closes the TCP connection and ends session 1.
    }

    // Session 2: connect fresh, the previously-written value must still be there.
    {
        let client = connect_client(port).await;
        let regs = client
            .read_holding_registers(1, 50, 1)
            .await
            .expect("session-2 read must succeed");
        let v = regs.value(regs.from_address()).unwrap();
        assert_eq!(v, 4242, "value written in session 1 must survive into session 2");
    }

    let final_state = drain_server(state_rx).await;
    assert_eq!(final_state.holding_regs[&50], 4242);
}

// ---------------------------------------------------------------------------
// TC12 — Independent address spaces:
// coils[5], discrete_inputs[5], holding[5], and input[5] are four
// independent values at the same numeric address.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc12_address_spaces_are_independent() {
    let mut app = TestServerApp::new();
    app.set_coil(5, true);
    app.set_discrete_input(5, false);
    app.set_holding_reg(5, 1234);
    app.set_input_reg(5, 5678);

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    let coil = client.read_multiple_coils(1, 5, 1).await.unwrap();
    assert_eq!(coil.value(5).unwrap(), true);

    let di = client.read_discrete_inputs(1, 5, 1).await.unwrap();
    assert_eq!(di.value(5).unwrap(), false);

    let hr = client.read_holding_registers(1, 5, 1).await.unwrap();
    assert_eq!(hr.value(5).unwrap(), 1234);

    let ir = client.read_input_registers(1, 5, 1).await.unwrap();
    assert_eq!(ir.value(5).unwrap(), 5678);

    drop(client);
    drain_server(state_rx).await;
}

// ---------------------------------------------------------------------------
// TC13 — Reading a range that spans both registered and unregistered
// addresses must return IllegalDataAddress (mirrors production behaviour
// in apps/server/src-tauri/src/modbus/listener_app.rs:471-478).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc13_partial_range_returns_exception() {
    let mut app = TestServerApp::new();
    // Register addresses 0 and 1 only — address 2 is intentionally missing.
    app.set_holding_reg(0, 10);
    app.set_holding_reg(1, 20);

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    // Reading 3 registers at 0..3 covers an unregistered address 2 → must fail.
    let result = client.read_holding_registers(1, 0, 3).await;
    assert!(
        result.is_err(),
        "read spanning registered + unregistered addresses must return an exception"
    );

    // Reading just 0..2 (both registered) must still succeed on the same connection.
    let ok = client
        .read_holding_registers(1, 0, 2)
        .await
        .expect("read of fully-registered range must succeed even after a prior exception");
    assert_eq!(ok.value(0).unwrap(), 10);
    assert_eq!(ok.value(1).unwrap(), 20);

    drop(client);
    drain_server(state_rx).await;
}

// ---------------------------------------------------------------------------
// TC14 — Pipelined concurrent requests on a single client.
//
// AsyncTcpClient is constructed with pipeline depth 32 (matches production).
// Issuing N reads concurrently from the same client must all succeed and
// return correct results — exercising the request/response correlation by
// transaction ID inside the library.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc14_pipelined_concurrent_reads() {
    let mut app = TestServerApp::new();
    for addr in 0..16u16 {
        app.set_holding_reg(addr, addr * 10);
    }

    let (port, state_rx) = setup_server(app).await;
    let client = std::sync::Arc::new(connect_client(port).await);

    // Fire 16 concurrent single-register reads.
    let mut handles = Vec::new();
    for addr in 0..16u16 {
        let c = std::sync::Arc::clone(&client);
        handles.push(tokio::spawn(async move {
            let regs = c.read_holding_registers(1, addr, 1).await.expect("read ok");
            (addr, regs.value(addr).unwrap())
        }));
    }

    let mut results: Vec<(u16, u16)> = Vec::new();
    for h in handles {
        results.push(h.await.expect("task must not panic"));
    }
    results.sort_by_key(|(a, _)| *a);

    let expected: Vec<(u16, u16)> = (0..16u16).map(|a| (a, a * 10)).collect();
    assert_eq!(
        results, expected,
        "all 16 concurrent reads must return their address-correlated values"
    );

    // Drop the only Arc so the underlying client is dropped, closing the TCP session.
    drop(client);
    drain_server(state_rx).await;
}

// ---------------------------------------------------------------------------
// TC15 — Client-side validation: quantity = 0 is rejected by the library
// before a frame is even sent (catches caller-side mistakes early).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tc15_quantity_zero_is_rejected() {
    let mut app = TestServerApp::new();
    app.set_holding_reg(0, 1);

    let (port, state_rx) = setup_server(app).await;
    let client = connect_client(port).await;

    let result = client.read_holding_registers(1, 0, 0).await;
    assert!(
        result.is_err(),
        "quantity = 0 must be rejected (either by client validation or by server exception)"
    );

    // The session must still be usable for valid requests.
    let ok = client
        .read_holding_registers(1, 0, 1)
        .await
        .expect("valid read after invalid one must succeed");
    assert_eq!(ok.value(0).unwrap(), 1);

    drop(client);
    drain_server(state_rx).await;
}
