//! Client-side iBus parsing & decoding commands.
//!
//! The client app does NOT store an overlay — it issues regular Modbus reads
//! (HR 9000..) via the existing `read_holding_registers` command, then hands
//! the raw word slices to these parser commands.

use ibus_core::{
    conformance::{run_conformance, ConformanceFinding},
    parser::{parse_descriptor, parse_identity, parse_manifest, parse_points, IdentityHeader},
    units, BlockType, DataType, EngineeringValue, IbusDescriptor, Identity, ManifestEntry,
    PointDesc, SIGNATURE_WORD, VERSION_WORD,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseIdentityRequest {
    pub words: Vec<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseIdentityResponse {
    pub identity: Identity,
    pub header: IdentityHeader,
}

#[tauri::command]
pub fn ibus_parse_identity(request: ParseIdentityRequest) -> Result<ParseIdentityResponse, String> {
    let (identity, header) =
        parse_identity(&request.words).map_err(|e| format!("{e:?}"))?;
    Ok(ParseIdentityResponse { identity, header })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseManifestRequest {
    pub words: Vec<u16>,
    pub count: u16,
}

#[tauri::command]
pub fn ibus_parse_manifest(request: ParseManifestRequest) -> Result<Vec<ManifestEntry>, String> {
    parse_manifest(&request.words, request.count).map_err(|e| format!("{e:?}"))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsePointsRequest {
    pub words: Vec<u16>,
    pub count: u16,
}

#[tauri::command]
pub fn ibus_parse_points(request: ParsePointsRequest) -> Result<Vec<PointDesc>, String> {
    parse_points(&request.words, request.count).map_err(|e| format!("{e:?}"))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseDescriptorRequest {
    pub identity_words: Vec<u16>,
    pub manifest_words: Vec<u16>,
    pub points_words: Vec<u16>,
}

#[tauri::command]
pub fn ibus_parse_descriptor(request: ParseDescriptorRequest) -> Result<IbusDescriptor, String> {
    parse_descriptor(
        &request.identity_words,
        &request.manifest_words,
        &request.points_words,
    )
    .map_err(|e| format!("{e:?}"))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodePointRequest {
    pub data_type: u16,
    pub scale_num: i16,
    pub scale_den: i16,
    pub words: Vec<u16>,
}

#[tauri::command]
pub fn ibus_decode_point(request: DecodePointRequest) -> Result<EngineeringValue, String> {
    let dt = DataType::from_u16(request.data_type).ok_or("invalid data type")?;
    ibus_core::codec::decode_register_point(dt, request.scale_num, request.scale_den, &request.words)
        .map_err(|e| format!("{e:?}"))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodePointRequest {
    pub data_type: u16,
    pub scale_num: i16,
    pub scale_den: i16,
    pub value: EngineeringValue,
}

#[tauri::command]
pub fn ibus_encode_point(request: EncodePointRequest) -> Result<Vec<u16>, String> {
    let dt = DataType::from_u16(request.data_type).ok_or("invalid data type")?;
    ibus_core::codec::encode_register_point(
        dt,
        request.scale_num,
        request.scale_den,
        &request.value,
    )
    .map_err(|e| format!("{e:?}"))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceRequest {
    pub signature: u16,
    pub version: u16,
    pub descriptor: IbusDescriptor,
    pub unused_range_reads_zero: Option<bool>,
}

#[tauri::command]
pub fn ibus_run_conformance(request: ConformanceRequest) -> Result<Vec<ConformanceFinding>, String> {
    Ok(run_conformance(
        request.signature,
        request.version,
        &request.descriptor,
        request.unused_range_reads_zero,
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitInfo {
    pub code: u16,
    pub symbol: String,
    pub label: String,
}

#[tauri::command]
pub fn ibus_lookup_unit(code: u16) -> UnitInfo {
    if let Some(u) = units::lookup(code) {
        UnitInfo {
            code,
            symbol: u.symbol.to_string(),
            label: u.label.to_string(),
        }
    } else {
        UnitInfo {
            code,
            symbol: format!("0x{code:02X}"),
            label: "Unknown".to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IbusConstants {
    pub signature_word: u16,
    pub version_word: u16,
    pub region_start: u16,
    pub region_end: u16,
    pub manifest_base_min: u16,
    pub manifest_entry_regs: u16,
    pub point_desc_regs: u16,
    pub identity_regs: u16,
}

#[tauri::command]
pub fn ibus_constants() -> IbusConstants {
    IbusConstants {
        signature_word: SIGNATURE_WORD,
        version_word: VERSION_WORD,
        region_start: ibus_core::REGION_START,
        region_end: ibus_core::REGION_END,
        manifest_base_min: ibus_core::MANIFEST_BASE_MIN,
        manifest_entry_regs: ibus_core::MANIFEST_ENTRY_REGS,
        point_desc_regs: ibus_core::POINT_DESC_REGS,
        identity_regs: 40,
    }
}

// Suppress unused-import warnings for re-exports surfaced only in command sigs.
#[allow(dead_code)]
fn _force_link() -> BlockType {
    BlockType::HoldingRegister
}
