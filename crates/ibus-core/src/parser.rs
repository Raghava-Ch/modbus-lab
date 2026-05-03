//! Client-side: parse raw HR words into `Identity`, `Vec<ManifestEntry>` and
//! `Vec<PointDesc>` — the inverse of `overlay::Overlay`.

use crate::codec::decode_ascii_field;
use crate::types::{
    BlockType, DataType, FW_REGS, Identity, IbusDescriptor, MANIFEST_BASE_MIN,
    MANIFEST_ENTRY_REGS, MODEL_REGS, ManifestEntry, NAME_REGS, POINT_DESC_REGS, PointDesc,
    REGION_END, SIGNATURE_WORD, VENDOR_REGS, VERSION_MAJOR,
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("HR 9000 signature mismatch: got 0x{got:04X}, expected 0x{want:04X}",
            want = SIGNATURE_WORD)]
    BadSignature { got: u16 },
    #[error("unsupported iBus major version {got}, this client supports {want}",
            want = VERSION_MAJOR)]
    UnsupportedMajor { got: u8 },
    #[error("manifest_addr {0} out of range {min}..={max}",
            min = MANIFEST_BASE_MIN, max = REGION_END)]
    ManifestAddrOutOfRange(u16),
    #[error("identity block (HR 9000..9039) requires 40 words, got {0}")]
    IdentityTooShort(usize),
    #[error("manifest words too short: need {need}, got {got}")]
    ManifestTooShort { need: usize, got: usize },
    #[error("point table words too short: need {need}, got {got}")]
    PointsTooShort { need: usize, got: usize },
    #[error("manifest entry {index}: invalid block_type {value}")]
    BadManifestBlockType { index: usize, value: u16 },
    #[error("point {index}: invalid block_type {value}")]
    BadPointBlockType { index: usize, value: u16 },
    #[error("point {index}: invalid data_type {value}")]
    BadPointDataType { index: usize, value: u16 },
}

/// Parse the identity block (HR 9000..9039 = 40 words). Returns identity and
/// the addresses (manifest_addr, point_addr, manifest_count, point_count).
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdentityHeader {
    pub point_count: u16,
    pub manifest_count: u16,
    pub manifest_addr: u16,
    pub point_addr: u16,
}

pub fn parse_identity(words: &[u16]) -> Result<(Identity, IdentityHeader), ParseError> {
    if words.len() < 40 {
        return Err(ParseError::IdentityTooShort(words.len()));
    }
    if words[0] != SIGNATURE_WORD {
        return Err(ParseError::BadSignature { got: words[0] });
    }
    let major = ((words[1] >> 8) & 0xFF) as u8;
    if major != VERSION_MAJOR {
        return Err(ParseError::UnsupportedMajor { got: major });
    }
    let header = IdentityHeader {
        point_count: words[2],
        manifest_count: words[4],
        manifest_addr: ((words[5] as u32) << 16 | words[6] as u32) as u16,
        point_addr: ((words[7] as u32) << 16 | words[8] as u32) as u16,
    };
    let identity = Identity {
        device_name: decode_ascii_field(&words[10..10 + NAME_REGS as usize]),
        vendor: decode_ascii_field(&words[18..18 + VENDOR_REGS as usize]),
        model: decode_ascii_field(&words[22..22 + MODEL_REGS as usize]),
        firmware: decode_ascii_field(&words[26..26 + FW_REGS as usize]),
    };
    Ok((identity, header))
}

pub fn parse_manifest(
    words: &[u16],
    count: u16,
) -> Result<Vec<ManifestEntry>, ParseError> {
    let need = (count as usize) * MANIFEST_ENTRY_REGS as usize;
    if words.len() < need {
        return Err(ParseError::ManifestTooShort { need, got: words.len() });
    }
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let base = i * MANIFEST_ENTRY_REGS as usize;
        let block_type = BlockType::from_u16(words[base])
            .ok_or(ParseError::BadManifestBlockType { index: i, value: words[base] })?;
        let name = decode_ascii_field(&words[base + 3..base + 7]);
        out.push(ManifestEntry {
            block_type,
            start_address: words[base + 1],
            length: words[base + 2],
            name,
        });
    }
    Ok(out)
}

pub fn parse_points(
    words: &[u16],
    count: u16,
) -> Result<Vec<PointDesc>, ParseError> {
    let need = (count as usize) * POINT_DESC_REGS as usize;
    if words.len() < need {
        return Err(ParseError::PointsTooShort { need, got: words.len() });
    }
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let base = i * POINT_DESC_REGS as usize;
        let block_type = BlockType::from_u16(words[base + 1])
            .ok_or(ParseError::BadPointBlockType { index: i, value: words[base + 1] })?;
        let data_type = DataType::from_u16(words[base + 2])
            .ok_or(ParseError::BadPointDataType { index: i, value: words[base + 2] })?;
        let name = decode_ascii_field(&words[base + 7..base + 13]);
        let description = decode_ascii_field(&words[base + 13..base + 18]);
        out.push(PointDesc {
            address: words[base],
            block_type,
            data_type,
            scale_num: words[base + 3] as i16,
            scale_den: words[base + 4] as i16,
            unit_code: words[base + 5],
            flags: words[base + 6],
            name,
            description,
        });
    }
    Ok(out)
}

/// Convenience: combine identity + manifest + points into a full descriptor.
pub fn parse_descriptor(
    identity_words: &[u16],
    manifest_words: &[u16],
    points_words: &[u16],
) -> Result<IbusDescriptor, ParseError> {
    let (identity, header) = parse_identity(identity_words)?;
    if !(MANIFEST_BASE_MIN..=REGION_END).contains(&header.manifest_addr) {
        return Err(ParseError::ManifestAddrOutOfRange(header.manifest_addr));
    }
    let manifest = parse_manifest(manifest_words, header.manifest_count)?;
    let points = parse_points(points_words, header.point_count)?;
    Ok(IbusDescriptor {
        identity,
        manifest,
        points,
        manifest_addr: header.manifest_addr,
    })
}
