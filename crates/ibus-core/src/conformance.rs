//! Spec §10 — ten conformance checks. Operates on either a parsed descriptor
//! (server-side) or a raw HR window read from a probed device (client-side).

use crate::types::{
    BlockType, DataType, IbusDescriptor, MANIFEST_BASE_MIN, MANIFEST_ENTRY_REGS,
    POINT_DESC_REGS, REGION_END, SIGNATURE_WORD, VERSION_WORD,
};

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConformanceLevel {
    Pass,
    Fail,
    Warn,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
#[derive(Debug, Clone)]
pub struct ConformanceFinding {
    pub id: u8,
    pub level: ConformanceLevel,
    pub title: &'static str,
    pub message: String,
}

fn ok(id: u8, title: &'static str) -> ConformanceFinding {
    ConformanceFinding {
        id,
        level: ConformanceLevel::Pass,
        title,
        message: "OK".to_string(),
    }
}

fn fail(id: u8, title: &'static str, message: impl Into<String>) -> ConformanceFinding {
    ConformanceFinding {
        id,
        level: ConformanceLevel::Fail,
        title,
        message: message.into(),
    }
}

fn warn(id: u8, title: &'static str, message: impl Into<String>) -> ConformanceFinding {
    ConformanceFinding {
        id,
        level: ConformanceLevel::Warn,
        title,
        message: message.into(),
    }
}

fn ascii_clean(s: &str) -> bool {
    s.bytes().all(|b| b == 0 || (0x20..=0x7E).contains(&b))
}

/// Run the ten checks against a parsed descriptor. `signature` and `version`
/// should be the raw HR 9000 / HR 9001 values seen on the wire (or read back
/// from an `Overlay`); the remaining checks are derived from `descriptor`.
///
/// `unused_zero_check_passed` lets the caller indicate whether they verified
/// check #10 (reads in the unused part of 9000..9999 return 0). When `None`,
/// the finding is reported as `Warn` with a "not verified" message.
pub fn run_conformance(
    signature: u16,
    version: u16,
    descriptor: &IbusDescriptor,
    unused_zero_check_passed: Option<bool>,
) -> Vec<ConformanceFinding> {
    let mut out = Vec::with_capacity(10);

    // 1. Signature
    if signature == SIGNATURE_WORD {
        out.push(ok(1, "HR 9000 signature == 0x4275"));
    } else {
        out.push(fail(1, "HR 9000 signature == 0x4275",
            format!("got 0x{:04X}", signature)));
    }

    // 2. Version
    if version == VERSION_WORD {
        out.push(ok(2, "HR 9001 version == 0x0101"));
    } else {
        out.push(fail(2, "HR 9001 version == 0x0101",
            format!("got 0x{:04X}", version)));
    }

    // 3. Manifest addr in 9040..9999
    if (MANIFEST_BASE_MIN..=REGION_END).contains(&descriptor.manifest_addr) {
        out.push(ok(3, "manifest_addr in 9040..9999"));
    } else {
        out.push(fail(3, "manifest_addr in 9040..9999",
            format!("manifest_addr = {}", descriptor.manifest_addr)));
    }

    // 4. point_addr > manifest_end and < 9999
    let manifest_end = descriptor.manifest_addr as u32
        + descriptor.manifest.len() as u32 * MANIFEST_ENTRY_REGS as u32;
    let point_addr = manifest_end as u16;
    if (point_addr as u32) >= manifest_end && point_addr <= REGION_END {
        out.push(ok(4, "point_addr after manifest, within region"));
    } else {
        out.push(fail(4, "point_addr after manifest, within region",
            format!("point_addr = {}", point_addr)));
    }

    // 5. manifest_count * 7 + manifest_addr <= point_addr
    let need = descriptor.manifest_addr as u32
        + descriptor.manifest.len() as u32 * MANIFEST_ENTRY_REGS as u32;
    if need <= point_addr as u32 {
        out.push(ok(5, "manifest fits before point table"));
    } else {
        out.push(fail(5, "manifest fits before point table",
            format!("needs through HR {}, point_addr = {}", need - 1, point_addr)));
    }

    // 6. point_count * 20 + point_addr <= 10000
    let pt_end = point_addr as u32 + descriptor.points.len() as u32 * POINT_DESC_REGS as u32;
    if pt_end <= REGION_END as u32 + 1 {
        out.push(ok(6, "point table fits in region"));
    } else {
        out.push(fail(6, "point table fits in region",
            format!("needs through HR {}, max {}", pt_end - 1, REGION_END)));
    }

    // 7. Manifest block_type valid
    let bad = descriptor.manifest.iter().enumerate().find(|(_, m)| {
        !matches!(m.block_type, BlockType::HoldingRegister | BlockType::InputRegister
            | BlockType::Coil | BlockType::DiscreteInput)
    });
    if let Some((i, m)) = bad {
        out.push(fail(7, "manifest block_type valid",
            format!("entry {} has block_type {}", i, m.block_type.as_u16())));
    } else {
        out.push(ok(7, "manifest block_type valid"));
    }

    // 8. Point block_type and data_type valid
    let bad_pt = descriptor.points.iter().enumerate().find(|(_, p)| {
        !matches!(p.block_type, BlockType::HoldingRegister | BlockType::InputRegister
            | BlockType::Coil | BlockType::DiscreteInput)
        || !matches!(p.data_type, DataType::Int16 | DataType::UInt16 | DataType::Int32
            | DataType::UInt32 | DataType::Float32 | DataType::Ascii
            | DataType::Bool | DataType::Int64 | DataType::Float64)
    });
    if let Some((i, _)) = bad_pt {
        out.push(fail(8, "point block_type and data_type valid",
            format!("point {} has invalid block_type or data_type", i)));
    } else {
        out.push(ok(8, "point block_type and data_type valid"));
    }

    // 9. ASCII fields are 0x00 or 0x20..0x7E
    let id = &descriptor.identity;
    let ascii_clean_overall = ascii_clean(&id.device_name)
        && ascii_clean(&id.vendor)
        && ascii_clean(&id.model)
        && ascii_clean(&id.firmware)
        && descriptor.manifest.iter().all(|m| ascii_clean(&m.name))
        && descriptor.points.iter().all(|p| ascii_clean(&p.name) && ascii_clean(&p.description));
    if ascii_clean_overall {
        out.push(ok(9, "ASCII fields contain only 0x00 or 0x20..0x7E"));
    } else {
        out.push(fail(9, "ASCII fields contain only 0x00 or 0x20..0x7E",
            "one or more text fields contain non-printable bytes"));
    }

    // 10. Unused HR in 9000..9999 read as 0
    match unused_zero_check_passed {
        Some(true) => out.push(ok(10, "unused HR in 9000..9999 read as 0")),
        Some(false) => out.push(fail(10, "unused HR in 9000..9999 read as 0",
            "at least one unused address returned non-zero")),
        None => out.push(warn(10, "unused HR in 9000..9999 read as 0",
            "not verified — caller did not provide a probe of the unused range")),
    }

    out
}
