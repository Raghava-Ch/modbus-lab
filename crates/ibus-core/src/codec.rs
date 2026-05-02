//! Big-endian word codec + ASCII pack/unpack helpers.
//!
//! Mirrors `pack_pair` / `read_text_register` in the C and Python references.

use crate::types::{DataType, EngineeringValue};

// ---------------------------------------------------------------------------
// ASCII packing (one register = two bytes, MSB first)
// ---------------------------------------------------------------------------

/// Pack two bytes from `text` (starting at byte `offset`) into a u16, big-endian.
/// Pads past end of string with NUL.
pub fn pack_ascii_pair(text: &str, offset: usize) -> u16 {
    let bytes = text.as_bytes();
    let hi = bytes.get(offset).copied().unwrap_or(0);
    let lo = bytes.get(offset + 1).copied().unwrap_or(0);
    ((hi as u16) << 8) | (lo as u16)
}

/// Read register `reg_index` of a packed-ASCII text field of width `field_regs`.
pub fn read_text_register(text: &str, field_regs: u16, reg_index: u16) -> u16 {
    if reg_index >= field_regs {
        return 0;
    }
    pack_ascii_pair(text, (reg_index as usize) * 2)
}

/// Decode a packed-ASCII field (`words.len()` registers) into a String,
/// trimming trailing NUL and ASCII whitespace.
pub fn decode_ascii_field(words: &[u16]) -> String {
    let mut out = Vec::with_capacity(words.len() * 2);
    for &w in words {
        out.push(((w >> 8) & 0xFF) as u8);
        out.push((w & 0xFF) as u8);
    }
    // Strip trailing NUL/space.
    while matches!(out.last(), Some(0) | Some(b' ')) {
        out.pop();
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// Big-endian numeric decoders / encoders
// ---------------------------------------------------------------------------

pub fn u32_from_be_words(hi: u16, lo: u16) -> u32 {
    ((hi as u32) << 16) | (lo as u32)
}

pub fn u32_to_be_words(v: u32) -> [u16; 2] {
    [((v >> 16) & 0xFFFF) as u16, (v & 0xFFFF) as u16]
}

pub fn i32_from_be_words(hi: u16, lo: u16) -> i32 {
    u32_from_be_words(hi, lo) as i32
}

pub fn f32_from_be_words(hi: u16, lo: u16) -> f32 {
    f32::from_bits(u32_from_be_words(hi, lo))
}

pub fn f32_to_be_words(v: f32) -> [u16; 2] {
    u32_to_be_words(v.to_bits())
}

pub fn u64_from_be_words(w: [u16; 4]) -> u64 {
    ((w[0] as u64) << 48) | ((w[1] as u64) << 32) | ((w[2] as u64) << 16) | (w[3] as u64)
}

pub fn u64_to_be_words(v: u64) -> [u16; 4] {
    [
        ((v >> 48) & 0xFFFF) as u16,
        ((v >> 32) & 0xFFFF) as u16,
        ((v >> 16) & 0xFFFF) as u16,
        (v & 0xFFFF) as u16,
    ]
}

pub fn i64_from_be_words(w: [u16; 4]) -> i64 {
    u64_from_be_words(w) as i64
}

pub fn f64_from_be_words(w: [u16; 4]) -> f64 {
    f64::from_bits(u64_from_be_words(w))
}

pub fn f64_to_be_words(v: f64) -> [u16; 4] {
    u64_to_be_words(v.to_bits())
}

// ---------------------------------------------------------------------------
// Scale helpers
// ---------------------------------------------------------------------------

/// Apply scale: engineering = raw * num / den.
pub fn apply_scale(raw: f64, num: i16, den: i16) -> f64 {
    let n = num as f64;
    let d = if den == 0 { 1.0 } else { den as f64 };
    raw * n / d
}

/// Invert scale: raw = engineering * den / num.
pub fn invert_scale(eng: f64, num: i16, den: i16) -> f64 {
    let n = if num == 0 { 1.0 } else { num as f64 };
    let d = den as f64;
    eng * d / n
}

// ---------------------------------------------------------------------------
// High-level point decode / encode for register-block points
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("expected {expected} register words, got {got}")]
    WrongLength { expected: usize, got: usize },
    #[error("ASCII point requires positive char length in scale_num")]
    BadAsciiLength,
}

/// Decode register words for a register-block point into an `EngineeringValue`.
/// `scale_num` is the ASCII char count when `data_type == Ascii`.
pub fn decode_register_point(
    data_type: DataType,
    scale_num: i16,
    scale_den: i16,
    words: &[u16],
) -> Result<EngineeringValue, CodecError> {
    fn need(words: &[u16], n: usize) -> Result<&[u16], CodecError> {
        if words.len() != n {
            Err(CodecError::WrongLength {
                expected: n,
                got: words.len(),
            })
        } else {
            Ok(words)
        }
    }
    match data_type {
        DataType::Int16 => {
            let w = need(words, 1)?;
            let raw = w[0] as i16 as f64;
            Ok(EngineeringValue::Number {
                value: apply_scale(raw, scale_num, scale_den),
                raw,
            })
        }
        DataType::UInt16 => {
            let w = need(words, 1)?;
            let raw = w[0] as f64;
            Ok(EngineeringValue::Number {
                value: apply_scale(raw, scale_num, scale_den),
                raw,
            })
        }
        DataType::Int32 => {
            let w = need(words, 2)?;
            let raw = i32_from_be_words(w[0], w[1]) as f64;
            Ok(EngineeringValue::Number {
                value: apply_scale(raw, scale_num, scale_den),
                raw,
            })
        }
        DataType::UInt32 => {
            let w = need(words, 2)?;
            let raw = u32_from_be_words(w[0], w[1]) as f64;
            Ok(EngineeringValue::Number {
                value: apply_scale(raw, scale_num, scale_den),
                raw,
            })
        }
        DataType::Float32 => {
            let w = need(words, 2)?;
            let raw = f32_from_be_words(w[0], w[1]) as f64;
            Ok(EngineeringValue::Number {
                value: apply_scale(raw, scale_num, scale_den),
                raw,
            })
        }
        DataType::Int64 => {
            let w = need(words, 4)?;
            let raw = i64_from_be_words([w[0], w[1], w[2], w[3]]) as f64;
            Ok(EngineeringValue::Number {
                value: apply_scale(raw, scale_num, scale_den),
                raw,
            })
        }
        DataType::Float64 => {
            let w = need(words, 4)?;
            let raw = f64_from_be_words([w[0], w[1], w[2], w[3]]);
            Ok(EngineeringValue::Number {
                value: apply_scale(raw, scale_num, scale_den),
                raw,
            })
        }
        DataType::Ascii => {
            if scale_num <= 0 {
                return Err(CodecError::BadAsciiLength);
            }
            let chars = scale_num as usize;
            let regs = (chars + 1) / 2;
            need(words, regs)?;
            Ok(EngineeringValue::Text(decode_ascii_field(words)))
        }
        DataType::Bool => {
            let w = need(words, 1)?;
            Ok(EngineeringValue::Bool(w[0] != 0))
        }
    }
}

/// Encode an `EngineeringValue` back into register words.
pub fn encode_register_point(
    data_type: DataType,
    scale_num: i16,
    scale_den: i16,
    value: &EngineeringValue,
) -> Result<Vec<u16>, CodecError> {
    let raw = match (data_type, value) {
        (DataType::Bool, EngineeringValue::Bool(b)) => return Ok(vec![if *b { 1 } else { 0 }]),
        (DataType::Ascii, EngineeringValue::Text(s)) => {
            if scale_num <= 0 {
                return Err(CodecError::BadAsciiLength);
            }
            let chars = scale_num as usize;
            let regs = (chars + 1) / 2;
            let mut out = Vec::with_capacity(regs);
            for i in 0..regs {
                out.push(pack_ascii_pair(s, i * 2));
            }
            return Ok(out);
        }
        (_, EngineeringValue::Number { value, raw: _ }) => invert_scale(*value, scale_num, scale_den),
        _ => return Err(CodecError::WrongLength { expected: 0, got: 0 }),
    };
    Ok(match data_type {
        DataType::Int16 => vec![(raw.round() as i32 as i16) as u16],
        DataType::UInt16 => vec![(raw.round() as i32).clamp(0, 0xFFFF) as u16],
        DataType::Int32 => {
            let v = raw.round() as i64 as i32 as u32;
            u32_to_be_words(v).to_vec()
        }
        DataType::UInt32 => {
            let v = (raw.round() as i64).clamp(0, 0xFFFF_FFFF) as u32;
            u32_to_be_words(v).to_vec()
        }
        DataType::Float32 => f32_to_be_words(raw as f32).to_vec(),
        DataType::Int64 => {
            let v = raw.round() as i64 as u64;
            u64_to_be_words(v).to_vec()
        }
        DataType::Float64 => f64_to_be_words(raw).to_vec(),
        DataType::Ascii | DataType::Bool => unreachable!(),
    })
}
