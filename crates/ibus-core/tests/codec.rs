//! Codec round-trips for ASCII pack/unpack, BE U32/I32/F32, scale apply/invert.

use ibus_core::codec::*;
use ibus_core::types::{DataType, EngineeringValue};

#[test]
fn ascii_pack_unpack_round_trip() {
    let s = "Climate";
    let words: Vec<u16> = (0..4).map(|i| pack_ascii_pair(s, i * 2)).collect();
    let decoded = decode_ascii_field(&words);
    assert_eq!(decoded, "Climate");
}

#[test]
fn ascii_pack_short_string() {
    assert_eq!(pack_ascii_pair("A", 0), 0x4100);
    assert_eq!(pack_ascii_pair("AB", 0), 0x4142);
    assert_eq!(pack_ascii_pair("AB", 2), 0x0000);
}

#[test]
fn u32_round_trip_be() {
    for v in [0u32, 1, 0xDEAD_BEEF, u32::MAX, 0x1234_5678] {
        let [hi, lo] = u32_to_be_words(v);
        assert_eq!(u32_from_be_words(hi, lo), v);
    }
}

#[test]
fn f32_round_trip_be() {
    for v in [0.0f32, 1.5, -273.15, f32::MIN, f32::MAX] {
        let [hi, lo] = f32_to_be_words(v);
        assert!((f32_from_be_words(hi, lo) - v).abs() < 1e-3 || v.is_nan());
    }
}

#[test]
fn scale_apply_invert() {
    // Indoor Temp = 235 raw, scale 1/10 → 23.5
    assert!((apply_scale(235.0, 1, 10) - 23.5).abs() < 1e-9);
    assert!((invert_scale(23.5, 1, 10) - 235.0).abs() < 1e-9);
    // Negative scale
    assert!((apply_scale(100.0, -1, 1) - -100.0).abs() < 1e-9);
}

#[test]
fn decode_uint16_with_scale() {
    let v = decode_register_point(DataType::UInt16, 1, 10, &[235]).unwrap();
    match v {
        EngineeringValue::Number { value, raw } => {
            assert!((value - 23.5).abs() < 1e-9);
            assert_eq!(raw, 235.0);
        }
        _ => panic!("wrong variant"),
    }
}

#[test]
fn decode_float32_be_words() {
    let [hi, lo] = f32_to_be_words(3.14);
    let v = decode_register_point(DataType::Float32, 1, 1, &[hi, lo]).unwrap();
    if let EngineeringValue::Number { raw, .. } = v {
        assert!((raw - 3.14).abs() < 1e-3);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn encode_uint16_round_trip() {
    let words = encode_register_point(
        DataType::UInt16,
        1,
        10,
        &EngineeringValue::Number { value: 23.5, raw: 0.0 },
    )
    .unwrap();
    assert_eq!(words, vec![235u16]);
}

#[test]
fn encode_decode_int32() {
    let val = -123_456_i32;
    let words = encode_register_point(
        DataType::Int32,
        1,
        1,
        &EngineeringValue::Number { value: val as f64, raw: 0.0 },
    )
    .unwrap();
    let v = decode_register_point(DataType::Int32, 1, 1, &words).unwrap();
    if let EngineeringValue::Number { raw, .. } = v {
        assert_eq!(raw as i32, val);
    } else {
        panic!("wrong variant");
    }
}

#[test]
fn ascii_decode_strips_padding() {
    // "Hi" packed in 2 regs: 0x4869, 0x0000
    assert_eq!(decode_ascii_field(&[0x4869, 0x0000]), "Hi");
}
