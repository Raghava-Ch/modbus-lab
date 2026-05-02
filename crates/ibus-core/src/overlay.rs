//! Server-side iBus reserved-region (HR 9000..9999) reader.
//!
//! Direct port of `IBusOverlay` (Python) and `ibus_read_hr` (C). Given a
//! validated descriptor, `Overlay::read_hr(addr)` returns the byte-exact
//! register value that the spec example dictates.

use crate::codec::{pack_ascii_pair, read_text_register};
use crate::types::{
    BlockType, FW_REGS, IbusDescriptor, MANIFEST_BASE_MIN, MANIFEST_ENTRY_REGS,
    MANIFEST_NAME_CHARS, MODEL_REGS, NAME_REGS, POINT_DESCRIPTION_CHARS, POINT_DESC_REGS,
    POINT_NAME_CHARS, REGION_END, REGION_START, SIGNATURE_WORD, VENDOR_REGS, VERSION_WORD,
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OverlayError {
    #[error("manifest_addr {0} must be in {min}..={max}",
            min = MANIFEST_BASE_MIN, max = REGION_END)]
    ManifestAddrOutOfRange(u16),
    #[error("manifest + point table overflow the iBus region (needs through HR {needed}, max {max})",
            max = REGION_END)]
    Overflow { needed: u32 },
    #[error("manifest entry {index} block_type {value} is invalid")]
    BadManifestBlockType { index: usize, value: u16 },
    #[error("point {index} block_type {value} is invalid")]
    BadPointBlockType { index: usize, value: u16 },
    #[error("identity field {field} length {got} exceeds {max}")]
    IdentityTooLong { field: &'static str, got: usize, max: usize },
    #[error("manifest entry {index} name length {got} exceeds {max}",
            max = MANIFEST_NAME_CHARS)]
    ManifestNameTooLong { index: usize, got: usize },
    #[error("point {index} name length {got} exceeds {max}",
            max = POINT_NAME_CHARS)]
    PointNameTooLong { index: usize, got: usize },
    #[error("point {index} description length {got} exceeds {max}",
            max = POINT_DESCRIPTION_CHARS)]
    PointDescriptionTooLong { index: usize, got: usize },
}

pub struct Overlay {
    descriptor: IbusDescriptor,
    point_addr: u16,
}

impl Overlay {
    pub fn new(descriptor: IbusDescriptor) -> Result<Self, OverlayError> {
        // Identity length checks
        let id = &descriptor.identity;
        if id.device_name.len() > NAME_REGS as usize * 2 {
            return Err(OverlayError::IdentityTooLong {
                field: "device_name",
                got: id.device_name.len(),
                max: NAME_REGS as usize * 2,
            });
        }
        if id.vendor.len() > VENDOR_REGS as usize * 2 {
            return Err(OverlayError::IdentityTooLong {
                field: "vendor",
                got: id.vendor.len(),
                max: VENDOR_REGS as usize * 2,
            });
        }
        if id.model.len() > MODEL_REGS as usize * 2 {
            return Err(OverlayError::IdentityTooLong {
                field: "model",
                got: id.model.len(),
                max: MODEL_REGS as usize * 2,
            });
        }
        if id.firmware.len() > FW_REGS as usize * 2 {
            return Err(OverlayError::IdentityTooLong {
                field: "firmware",
                got: id.firmware.len(),
                max: FW_REGS as usize * 2,
            });
        }

        // Manifest entry checks
        for (i, m) in descriptor.manifest.iter().enumerate() {
            if !matches!(
                m.block_type,
                BlockType::HoldingRegister | BlockType::InputRegister
                    | BlockType::Coil | BlockType::DiscreteInput
            ) {
                return Err(OverlayError::BadManifestBlockType {
                    index: i,
                    value: m.block_type.as_u16(),
                });
            }
            if m.name.len() > MANIFEST_NAME_CHARS {
                return Err(OverlayError::ManifestNameTooLong { index: i, got: m.name.len() });
            }
        }

        for (i, p) in descriptor.points.iter().enumerate() {
            if !matches!(
                p.block_type,
                BlockType::HoldingRegister | BlockType::InputRegister
                    | BlockType::Coil | BlockType::DiscreteInput
            ) {
                return Err(OverlayError::BadPointBlockType {
                    index: i,
                    value: p.block_type.as_u16(),
                });
            }
            if p.name.len() > POINT_NAME_CHARS {
                return Err(OverlayError::PointNameTooLong { index: i, got: p.name.len() });
            }
            if p.description.len() > POINT_DESCRIPTION_CHARS {
                return Err(OverlayError::PointDescriptionTooLong {
                    index: i,
                    got: p.description.len(),
                });
            }
        }

        let manifest_addr = descriptor.manifest_addr;
        if !(MANIFEST_BASE_MIN..=REGION_END).contains(&manifest_addr) {
            return Err(OverlayError::ManifestAddrOutOfRange(manifest_addr));
        }
        let point_addr = manifest_addr
            .saturating_add(descriptor.manifest.len() as u16 * MANIFEST_ENTRY_REGS);
        let end = point_addr as u32 + descriptor.points.len() as u32 * POINT_DESC_REGS as u32;
        if end > REGION_END as u32 + 1 {
            return Err(OverlayError::Overflow { needed: end - 1 });
        }

        Ok(Self { descriptor, point_addr })
    }

    pub fn descriptor(&self) -> &IbusDescriptor {
        &self.descriptor
    }

    pub fn point_addr(&self) -> u16 {
        self.point_addr
    }

    pub fn manifest_addr(&self) -> u16 {
        self.descriptor.manifest_addr
    }

    pub fn owns(addr: u16) -> bool {
        (REGION_START..=REGION_END).contains(&addr)
    }

    /// Read a single HR. Always returns a u16 (zero for reserved/unused slots).
    pub fn read_hr(&self, addr: u16) -> u16 {
        if !Self::owns(addr) {
            return 0;
        }
        if addr <= 9039 {
            return self.read_identity_block(addr);
        }
        let manifest_addr = self.descriptor.manifest_addr;
        let manifest_count = self.descriptor.manifest.len() as u16;
        if manifest_count > 0
            && addr >= manifest_addr
            && addr < manifest_addr + manifest_count * MANIFEST_ENTRY_REGS
        {
            return self.read_manifest(addr);
        }
        let point_count = self.descriptor.points.len() as u16;
        if point_count > 0
            && addr >= self.point_addr
            && addr < self.point_addr + point_count * POINT_DESC_REGS
        {
            return self.read_point_table(addr);
        }
        0
    }

    fn read_identity_block(&self, addr: u16) -> u16 {
        let id = &self.descriptor.identity;
        match addr {
            9000 => SIGNATURE_WORD,
            9001 => VERSION_WORD,
            9002 => self.descriptor.points.len() as u16,
            9003 => 0,
            9004 => self.descriptor.manifest.len() as u16,
            9005 => 0,
            9006 => self.descriptor.manifest_addr,
            9007 => 0,
            9008 => self.point_addr,
            9009 => 0,
            9010..=9017 => read_text_register(&id.device_name, NAME_REGS, addr - 9010),
            9018..=9021 => read_text_register(&id.vendor, VENDOR_REGS, addr - 9018),
            9022..=9025 => read_text_register(&id.model, MODEL_REGS, addr - 9022),
            9026..=9027 => read_text_register(&id.firmware, FW_REGS, addr - 9026),
            _ => 0,
        }
    }

    fn read_manifest(&self, addr: u16) -> u16 {
        let off = addr - self.descriptor.manifest_addr;
        let entry = (off / MANIFEST_ENTRY_REGS) as usize;
        let field = off % MANIFEST_ENTRY_REGS;
        let m = &self.descriptor.manifest[entry];
        match field {
            0 => m.block_type.as_u16(),
            1 => m.start_address,
            2 => m.length,
            3 => pack_ascii_pair(&m.name, 0),
            4 => pack_ascii_pair(&m.name, 2),
            5 => pack_ascii_pair(&m.name, 4),
            6 => pack_ascii_pair(&m.name, 6),
            _ => 0,
        }
    }

    fn read_point_table(&self, addr: u16) -> u16 {
        let off = addr - self.point_addr;
        let entry = (off / POINT_DESC_REGS) as usize;
        let field = off % POINT_DESC_REGS;
        let p = &self.descriptor.points[entry];
        match field {
            0 => p.address,
            1 => p.block_type.as_u16(),
            2 => p.data_type.as_u16(),
            3 => p.scale_num as u16,
            4 => p.scale_den as u16,
            5 => p.unit_code,
            6 => p.flags,
            7..=12 => pack_ascii_pair(&p.name, ((field - 7) * 2) as usize),
            13..=17 => pack_ascii_pair(&p.description, ((field - 13) * 2) as usize),
            18 | 19 => 0,
            _ => 0,
        }
    }
}
