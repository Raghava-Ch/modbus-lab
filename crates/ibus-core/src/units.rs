//! ASHRAE 135 / BACnet engineering unit codes.
//!
//! This is a curated subset that matches the C/Python references plus a few
//! additions commonly needed for HVAC / power monitoring devices. Extend on
//! demand; the spec defers to the full ASHRAE 135 Annex B table.

#[derive(Debug, Clone, Copy)]
pub struct UnitDef {
    pub code: u16,
    pub symbol: &'static str,
    pub label: &'static str,
}

pub const UNIT_NONE: u16 = 0x70;

pub const UNITS: &[UnitDef] = &[
    UnitDef { code: 0x05, symbol: "A", label: "Amperes" },
    UnitDef { code: 0x08, symbol: "V", label: "Volts" },
    UnitDef { code: 0x11, symbol: "Hz", label: "Hertz" },
    UnitDef { code: 0x1F, symbol: "W", label: "Watts" },
    UnitDef { code: 0x20, symbol: "kW", label: "Kilowatts" },
    UnitDef { code: 0x27, symbol: "kWh", label: "Kilowatt-hours" },
    UnitDef { code: 0x2F, symbol: "°C", label: "Degrees Celsius" },
    UnitDef { code: 0x31, symbol: "%", label: "Percent" },
    UnitDef { code: 0x3A, symbol: "m³/h", label: "Cubic meters per hour" },
    UnitDef { code: 0x62, symbol: "%RH", label: "Percent relative humidity" },
    UnitDef { code: 0x70, symbol: "", label: "No units" },
];

pub fn lookup(code: u16) -> Option<&'static UnitDef> {
    UNITS.iter().find(|u| u.code == code)
}

pub fn symbol(code: u16) -> &'static str {
    lookup(code).map(|u| u.symbol).unwrap_or("")
}

pub fn label(code: u16) -> &'static str {
    lookup(code).map(|u| u.label).unwrap_or("Unknown unit")
}
