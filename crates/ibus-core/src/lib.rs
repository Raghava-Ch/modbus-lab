//! iBus v1.1 reference implementation in Rust.
//!
//! This crate is the byte-exact equivalent of the C and Python references
//! shipped in `ibus.tmp.specs/ibus-kit-2/reference/`. It is consumed by both
//! Tauri apps in this workspace so client (master/scanner) and server
//! (slave/publisher) stay in lock-step with the spec.
//!
//! The full specification lives at
//! `ibus.tmp.specs/ibus-kit-2/spec/iBus_Specification_v1.1.md`.

pub mod codec;
pub mod conformance;
pub mod overlay;
pub mod parser;
pub mod types;
pub mod units;

pub use conformance::{ConformanceFinding, ConformanceLevel, run_conformance};
pub use overlay::{Overlay, OverlayError};
pub use parser::{ParseError, parse_descriptor};
pub use types::{
    BlockType, DataType, EngineeringValue, FLAG_PERSISTENT, FLAG_WRITABLE, Identity,
    IbusDescriptor, IbusInfo, MANIFEST_BASE_MIN, MANIFEST_ENTRY_REGS, ManifestEntry,
    POINT_DESC_REGS, PointDesc, REGION_END, REGION_START, SIGNATURE_WORD, VERSION_WORD,
};
