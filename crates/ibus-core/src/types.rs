//! Constants, enums, and DTOs that mirror `ibus.h` and `ibus.py`.

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// HR 9000: ASCII "Bu".
pub const SIGNATURE_WORD: u16 = 0x4275;
/// HR 9001: protocol version (0x0101 = v1.1, MAJOR.minor as BCD).
pub const VERSION_WORD: u16 = 0x0101;
pub const VERSION_MAJOR: u8 = 0x01;
pub const VERSION_MINOR: u8 = 0x01;

pub const REGION_START: u16 = 9000;
pub const REGION_END: u16 = 9999;
pub const MANIFEST_BASE_MIN: u16 = 9040;

/// Identity-block field widths (in 16-bit registers).
pub const NAME_REGS: u16 = 8; // 16 ASCII chars
pub const VENDOR_REGS: u16 = 4; // 8 ASCII chars
pub const MODEL_REGS: u16 = 4; // 8 ASCII chars
pub const FW_REGS: u16 = 2; // 4 ASCII chars

pub const NAME_CHARS: usize = (NAME_REGS as usize) * 2;
pub const VENDOR_CHARS: usize = (VENDOR_REGS as usize) * 2;
pub const MODEL_CHARS: usize = (MODEL_REGS as usize) * 2;
pub const FW_CHARS: usize = (FW_REGS as usize) * 2;

pub const POINT_NAME_CHARS: usize = 12;
pub const POINT_DESCRIPTION_CHARS: usize = 10;
pub const MANIFEST_NAME_CHARS: usize = 8;

/// Manifest entry size (registers per entry).
pub const MANIFEST_ENTRY_REGS: u16 = 7;
/// Point descriptor size (registers per point).
pub const POINT_DESC_REGS: u16 = 20;

/// Point-descriptor flags.
pub const FLAG_WRITABLE: u16 = 0x0001;
pub const FLAG_PERSISTENT: u16 = 0x0004;

// ---------------------------------------------------------------------------
// Block types (spec §7)
// ---------------------------------------------------------------------------

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum BlockType {
    HoldingRegister = 1,
    InputRegister = 2,
    Coil = 3,
    DiscreteInput = 4,
}

impl BlockType {
    pub fn from_u16(v: u16) -> Option<Self> {
        match v {
            1 => Some(BlockType::HoldingRegister),
            2 => Some(BlockType::InputRegister),
            3 => Some(BlockType::Coil),
            4 => Some(BlockType::DiscreteInput),
            _ => None,
        }
    }
    pub fn as_u16(self) -> u16 {
        self as u16
    }
}

// ---------------------------------------------------------------------------
// Data types (spec §5)
// ---------------------------------------------------------------------------

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum DataType {
    Int16 = 1,
    UInt16 = 2,
    Int32 = 3,
    UInt32 = 4,
    Float32 = 5,
    Ascii = 6,
    Bool = 7,
    Int64 = 8,
    Float64 = 9,
}

impl DataType {
    pub fn from_u16(v: u16) -> Option<Self> {
        match v {
            1 => Some(DataType::Int16),
            2 => Some(DataType::UInt16),
            3 => Some(DataType::Int32),
            4 => Some(DataType::UInt32),
            5 => Some(DataType::Float32),
            6 => Some(DataType::Ascii),
            7 => Some(DataType::Bool),
            8 => Some(DataType::Int64),
            9 => Some(DataType::Float64),
            _ => None,
        }
    }
    pub fn as_u16(self) -> u16 {
        self as u16
    }

    /// How many 16-bit Modbus registers this data type occupies for *register*
    /// block types. For ASCII the actual length is carried in `scale_num`
    /// (chars), which the caller converts to (chars + 1) / 2 registers.
    /// For BOOL on coils/DI, the underlying transport returns bits.
    pub fn fixed_register_words(self) -> Option<u16> {
        match self {
            DataType::Int16 | DataType::UInt16 => Some(1),
            DataType::Int32 | DataType::UInt32 | DataType::Float32 => Some(2),
            DataType::Int64 | DataType::Float64 => Some(4),
            DataType::Ascii | DataType::Bool => None,
        }
    }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub device_name: String,
    pub vendor: String,
    pub model: String,
    pub firmware: String,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestEntry {
    pub block_type: BlockType,
    pub start_address: u16,
    pub length: u16,
    pub name: String,
}

#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointDesc {
    pub address: u16,
    pub block_type: BlockType,
    pub data_type: DataType,
    pub scale_num: i16,
    pub scale_den: i16,
    pub unit_code: u16,
    pub flags: u16,
    pub name: String,
    pub description: String,
}

impl PointDesc {
    pub fn is_writable(&self) -> bool {
        self.flags & FLAG_WRITABLE != 0
    }
    pub fn is_persistent(&self) -> bool {
        self.flags & FLAG_PERSISTENT != 0
    }
}

/// A complete iBus device description — what the server publishes and what
/// the client receives after a successful probe.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IbusDescriptor {
    pub identity: Identity,
    pub manifest: Vec<ManifestEntry>,
    pub points: Vec<PointDesc>,
    /// Where the manifest table starts (≥ 9040, ≤ 9999).
    pub manifest_addr: u16,
}

impl Default for IbusDescriptor {
    fn default() -> Self {
        Self {
            identity: Identity::default(),
            manifest: Vec::new(),
            points: Vec::new(),
            manifest_addr: MANIFEST_BASE_MIN,
        }
    }
}

/// Result of a single `ibus_probe` (HR 9000..9001 read).
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IbusInfo {
    pub signature_ok: bool,
    pub signature: u16,
    pub version: u16,
    pub version_major: u8,
    pub version_minor: u8,
}

impl IbusInfo {
    pub fn from_words(sig: u16, ver: u16) -> Self {
        Self {
            signature_ok: sig == SIGNATURE_WORD,
            signature: sig,
            version: ver,
            version_major: ((ver >> 8) & 0xFF) as u8,
            version_minor: (ver & 0xFF) as u8,
        }
    }
}

/// Engineering-value union returned by the client when it decodes a point.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "kind", rename_all = "camelCase"))]
#[derive(Debug, Clone, PartialEq)]
pub enum EngineeringValue {
    /// Scaled numeric value (any of int / uint / float types), already
    /// `raw * scale_num / scale_den`.
    Number { value: f64, raw: f64 },
    Bool(bool),
    Text(String),
}
