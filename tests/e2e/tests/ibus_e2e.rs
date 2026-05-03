//! End-to-end iBus v1.1 round-trip tests.
//!
//! These tests don't go through Tauri — they spin up a Modbus TCP server that
//! serves an iBus overlay (built from `ibus_core::Overlay`) for HR 9000..9999,
//! then a Modbus TCP client reads the identity / manifest / point-descriptor
//! blocks and re-parses them with `ibus_core::parser::*`.  A successful
//! round-trip proves the codec is byte-exact.

use std::collections::HashMap;

use ibus_core::{
    conformance::{run_conformance, ConformanceLevel},
    parser::{parse_identity, parse_manifest, parse_points},
    BlockType, DataType, IbusDescriptor, Identity, ManifestEntry, Overlay, PointDesc,
    SIGNATURE_WORD, VERSION_WORD,
};
use mbus_core::errors::ExceptionCode;
use mbus_core::function_codes::public::FunctionCode;
use modbus_rs::mbus_async::server::{
    AsyncAppHandler, AsyncTcpServer, AsyncTrafficNotifier, ModbusRequest, ModbusResponse,
};
use modbus_rs::mbus_async::AsyncTcpClient;
use modbus_rs::UnitIdOrSlaveAddr;
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// Test server: iBus overlay + plain HR map for non-overlay addresses.
// ---------------------------------------------------------------------------

struct IbusServerApp {
    overlay: Overlay,
    holding_regs: HashMap<u16, u16>,
}

impl AsyncTrafficNotifier for IbusServerApp {}

impl AsyncAppHandler for IbusServerApp {
    async fn handle(&mut self, req: ModbusRequest) -> ModbusResponse {
        match req {
            ModbusRequest::ReadHoldingRegisters { address, count, .. } => {
                let mut out = Vec::with_capacity(count as usize);
                for i in 0..count as u16 {
                    let addr = address + i;
                    if (9000..=9999).contains(&addr) {
                        out.push(self.overlay.read_hr(addr));
                    } else if let Some(&v) = self.holding_regs.get(&addr) {
                        out.push(v);
                    } else {
                        return ModbusResponse::exception(
                            FunctionCode::ReadHoldingRegisters,
                            ExceptionCode::IllegalDataAddress,
                        );
                    }
                }
                ModbusResponse::registers(FunctionCode::ReadHoldingRegisters, &out)
            }
            _ => ModbusResponse::exception(
                FunctionCode::ReadCoils,
                ExceptionCode::IllegalFunction,
            ),
        }
    }
}

fn sample_descriptor() -> IbusDescriptor {
    IbusDescriptor {
        identity: Identity {
            device_name: "Zone01 Thermost1".to_string(),
            vendor: "Acme Co.".to_string(),
            model: "T-100".to_string(),
            firmware: "1.02".to_string(),
        },
        manifest_addr: 9040,
        manifest: vec![
            ManifestEntry {
                block_type: BlockType::HoldingRegister,
                start_address: 0,
                length: 4,
                name: "Setpts".to_string(),
            },
            ManifestEntry {
                block_type: BlockType::InputRegister,
                start_address: 0,
                length: 2,
                name: "Temps".to_string(),
            },
        ],
        points: vec![
            PointDesc {
                address: 0,
                block_type: BlockType::HoldingRegister,
                data_type: DataType::Int16,
                scale_num: 1,
                scale_den: 10,
                unit_code: 0x2f,
                flags: 0x0001,
                name: "HeatSetpt".to_string(),
                description: "Heat".to_string(),
            },
            PointDesc {
                address: 0,
                block_type: BlockType::InputRegister,
                data_type: DataType::Int16,
                scale_num: 1,
                scale_den: 10,
                unit_code: 0x2f,
                flags: 0,
                name: "RoomTemp".to_string(),
                description: "RoomTemp".to_string(),
            },
        ],
    }
}

async fn setup_ibus_server(app: IbusServerApp) -> (u16, oneshot::Receiver<IbusServerApp>) {
    let unit = UnitIdOrSlaveAddr::try_from(1u8).expect("unit id 1 is always valid");
    let server = AsyncTcpServer::bind("127.0.0.1:0", unit)
        .await
        .expect("bind to port 0 must succeed");
    let port = server.local_addr().expect("local_addr").port();
    let (tx, rx) = oneshot::channel::<IbusServerApp>();
    let mut app = app;
    tokio::spawn(async move {
        if let Ok((mut session, _)) = server.accept().await {
            let _ = session.run(&mut app).await;
        }
        let _ = tx.send(app);
    });
    (port, rx)
}

async fn read_words(client: &AsyncTcpClient<32>, start: u16, count: u16) -> Vec<u16> {
    let regs = client
        .read_holding_registers(1, start, count)
        .await
        .expect("read_holding_registers ok");
    let from = regs.from_address();
    (0..regs.quantity())
        .map(|i| regs.value(from + i).expect("addr within block"))
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ibus_e2e_full_probe_round_trip() {
    let descriptor = sample_descriptor();
    let overlay = Overlay::new(descriptor.clone()).expect("overlay must build");

    let app = IbusServerApp {
        overlay,
        holding_regs: HashMap::new(),
    };
    let (port, state_rx) = setup_ibus_server(app).await;

    let client = AsyncTcpClient::<32>::new_with_pipeline("127.0.0.1", port)
        .expect("client construction");
    client.connect().await.expect("connect");

    // 1. Identity (HR 9000..9039)
    let identity_words = read_words(&client, 9000, 40).await;
    assert_eq!(identity_words[0], SIGNATURE_WORD);
    assert_eq!(identity_words[1], VERSION_WORD);
    let (identity, header) = parse_identity(&identity_words).expect("parse_identity");
    assert_eq!(identity.device_name, descriptor.identity.device_name);
    assert_eq!(identity.vendor, descriptor.identity.vendor);
    assert_eq!(identity.model, descriptor.identity.model);
    assert_eq!(identity.firmware, descriptor.identity.firmware);
    assert_eq!(header.manifest_addr, descriptor.manifest_addr);
    assert_eq!(header.manifest_count as usize, descriptor.manifest.len());
    assert_eq!(header.point_count as usize, descriptor.points.len());

    // 2. Manifest table
    let manifest_words = read_words(
        &client,
        header.manifest_addr,
        header.manifest_count * ibus_core::MANIFEST_ENTRY_REGS,
    )
    .await;
    let manifest = parse_manifest(&manifest_words, header.manifest_count).expect("parse_manifest");
    assert_eq!(manifest, descriptor.manifest);

    // 3. Point descriptors
    let point_words = read_words(
        &client,
        header.point_addr,
        header.point_count * ibus_core::POINT_DESC_REGS,
    )
    .await;
    let points = parse_points(&point_words, header.point_count).expect("parse_points");
    assert_eq!(points, descriptor.points);

    // 4. Conformance — should be all-pass except #10 (which we mark Warn when unchecked).
    let findings = run_conformance(SIGNATURE_WORD, VERSION_WORD, &descriptor, Some(true));
    let failures: Vec<_> = findings
        .iter()
        .filter(|f| f.level == ConformanceLevel::Fail)
        .collect();
    assert!(
        failures.is_empty(),
        "no conformance failures expected, got: {failures:?}"
    );

    drop(client);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), state_rx).await;
}

#[tokio::test]
async fn ibus_e2e_signature_word_is_ascii_bu() {
    // Spec §6.1: HR 9000 = ASCII "Bu" big-endian = 0x4275.
    let descriptor = sample_descriptor();
    let overlay = Overlay::new(descriptor).expect("overlay must build");
    let app = IbusServerApp {
        overlay,
        holding_regs: HashMap::new(),
    };
    let (port, state_rx) = setup_ibus_server(app).await;
    let client = AsyncTcpClient::<32>::new_with_pipeline("127.0.0.1", port)
        .expect("client");
    client.connect().await.expect("connect");

    let words = read_words(&client, 9000, 2).await;
    assert_eq!(words[0], 0x4275, "signature must be ASCII 'Bu'");
    assert_eq!(words[1], 0x0101, "version must be 1.1 (BCD)");
    assert_eq!(((words[0] >> 8) & 0xFF) as u8 as char, 'B');
    assert_eq!((words[0] & 0xFF) as u8 as char, 'u');

    drop(client);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), state_rx).await;
}
