//! # apro-harness
//!
//! The bridge between the CAD application and the platform, plus the data contract it
//! publishes against.
//!
//! This crate exists to **verify** the orchestration layer against the real applications.
//! In production the two halves belong in their own repos:
//!
//! * `apro-cad-bridge` lives in `aproCAD/` because it depends on `apro-document` and
//!   `apro-massprops`.
//! * `hex-bridge` lives in `hexadof2/` because it depends on `hex-model`.
//!
//! The platform must never depend on an application, which is why this harness is a
//! standalone workspace rather than a member of `APRO-works`.
//!
//! ## The unit boundary
//!
//! `aproCAD` computes mass properties in **document units**, which default to
//! millimetres. Its mass is already kilograms (density is `kg/mm³`), but its centre of
//! gravity is in millimetres and its inertia is in `kg·mm²`.
//!
//! HexaDOF is SI internally. So the conversion at the publish boundary is:
//!
//! | quantity | factor |
//! | --- | --- |
//! | mass | 1 (already kg) |
//! | centre of gravity | `metres_per_unit` (1000× for mm) |
//! | inertia | `metres_per_unit²` (**1e6×** for mm) |
//! | volume | `metres_per_unit³` |
//!
//! Getting inertia wrong is a factor of one million and produces plausible-looking
//! flight dynamics. [`MassPropertiesV1`] therefore declares `units` explicitly and
//! [`to_model_document`] **refuses a payload that does not declare SI** rather than
//! guessing.

use serde::{Deserialize, Serialize};

/// Published artifact type for CAD mass properties.
///
/// The unit contract is in the type id, so it is immutable and self-documenting: a
/// consumer cannot receive this type without knowing the payload is SI.
///
/// Note the `-v1` suffix rather than `.v1`: type-id segments are kebab-case only
/// (`a-z`, `0-9`, `-`), so a dot is rejected as an invalid type id.
pub const MASS_PROPERTIES_TYPE: &str = "apro-cad/mass-properties-si-v1";

/// The marker every payload of [`MASS_PROPERTIES_TYPE`] must carry.
pub const SI_MARKER: &str = "SI";

/// The unit system a CAD document is authored in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceUnits {
    Millimeters,
    Centimeters,
    Meters,
    Inches,
    Feet,
}

impl SourceUnits {
    /// Metres per one unit of length.
    pub fn metres_per_unit(self) -> f64 {
        match self {
            SourceUnits::Millimeters => 0.001,
            SourceUnits::Centimeters => 0.01,
            SourceUnits::Meters => 1.0,
            SourceUnits::Inches => 0.0254,
            SourceUnits::Feet => 0.3048,
        }
    }

    /// `kg·m²` per one inertia unit (`kg·<length>²`).
    pub fn inertia_scale(self) -> f64 {
        let s = self.metres_per_unit();
        s * s
    }

    /// `m³` per one volume unit.
    pub fn volume_scale(self) -> f64 {
        let s = self.metres_per_unit();
        s * s * s
    }

    /// Read the unit system out of a parsed CAD document.
    pub fn from_aprocad(units: &apro_document::Units) -> Self {
        match units {
            apro_document::Units::Millimeters => SourceUnits::Millimeters,
            apro_document::Units::Centimeters => SourceUnits::Centimeters,
            apro_document::Units::Meters => SourceUnits::Meters,
            apro_document::Units::Inches => SourceUnits::Inches,
            apro_document::Units::Feet => SourceUnits::Feet,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SourceUnits::Millimeters => "mm",
            SourceUnits::Centimeters => "cm",
            SourceUnits::Meters => "m",
            SourceUnits::Inches => "in",
            SourceUnits::Feet => "ft",
        }
    }
}

/// SI mass properties, as published to the platform.
///
/// Derived from [`apro_massprops::MassProperties`], which is expressed in document units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MassPropertiesV1 {
    pub schema: String,
    /// Always [`SI_MARKER`]. Consumers must never have to guess.
    pub units: String,
    pub mass_kg: f64,
    /// Body-frame centre of gravity, in metres.
    pub center_of_gravity_m: [f64; 3],
    /// Inertia about the centre of gravity, in `kg·m²`, as a symmetric 3x3 matrix.
    pub inertia_kg_m2: [[f64; 3]; 3],
    pub volume_m3: f64,
    /// Original document units, kept for provenance.
    pub source_units: SourceUnits,
    pub source_note: String,
}

impl MassPropertiesV1 {
    /// Convert native CAD mass properties into the published SI form.
    ///
    /// This is the only place unit conversion happens on the producer side.
    pub fn from_aprocad(native: &apro_massprops::MassProperties, source: SourceUnits) -> Self {
        let length = source.metres_per_unit();
        let inertia = source.inertia_scale();
        let volume = source.volume_scale();

        Self {
            schema: MASS_PROPERTIES_TYPE.to_string(),
            units: SI_MARKER.to_string(),
            // Already kilograms: aproCAD's density is kg/mm³.
            mass_kg: native.mass,
            center_of_gravity_m: [
                native.center_of_mass[0] * length,
                native.center_of_mass[1] * length,
                native.center_of_mass[2] * length,
            ],
            inertia_kg_m2: native.inertia_tensor.map(|row| row.map(|cell| cell * inertia)),
            volume_m3: native.volume * volume,
            source_units: source,
            source_note: format!(
                "converted from {} at the publish boundary; mass needed no conversion \
                 because aproCAD density is kg/mm^3",
                source.as_str()
            ),
        }
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// Largest relative asymmetry in the inertia matrix, for the consumer's sanity check.
    pub fn inertia_asymmetry(&self) -> f64 {
        let m = &self.inertia_kg_m2;
        let pairs = [
            (m[0][1], m[1][0]),
            (m[0][2], m[2][0]),
            (m[1][2], m[2][1]),
        ];
        pairs
            .iter()
            .map(|(a, b)| {
                let scale = a.abs().max(b.abs()).max(1e-12);
                (a - b).abs() / scale
            })
            .fold(0.0_f64, f64::max)
    }
}

/// Reference geometry in SI, published alongside mass properties.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ReferenceGeometrySi {
    /// Aerodynamic reference area, `m²`. A convention, not a derivation.
    pub reference_area_m2: f64,
    pub reference_length_m: f64,
    pub body_diameter_m: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    /// The payload did not declare SI. Refusing beats guessing by a factor of 1e6.
    NotSi { units: String },
    NotFinite { field: &'static str },
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BridgeError::NotSi { units } => write!(
                f,
                "payload declares units {units:?}; this consumer requires {SI_MARKER:?} \
                 and will not guess"
            ),
            BridgeError::NotFinite { field } => {
                write!(f, "field {field} is not finite")
            }
        }
    }
}

impl std::error::Error for BridgeError {}

/// Map an SI payload onto HexaDOF's model document.
///
/// The result serialises to the JSON that `hex_model::import_json` already knows how to
/// read, validate, and convert — so the consumer needs no bespoke parsing.
pub fn to_model_document(
    payload: &MassPropertiesV1,
    model_id: &str,
    name: &str,
    reference: ReferenceGeometrySi,
) -> Result<hex_model::ModelDocument, BridgeError> {
    if payload.units != SI_MARKER {
        return Err(BridgeError::NotSi {
            units: payload.units.clone(),
        });
    }
    if !payload.mass_kg.is_finite() {
        return Err(BridgeError::NotFinite { field: "mass_kg" });
    }
    if !payload.center_of_gravity_m.iter().all(|v| v.is_finite()) {
        return Err(BridgeError::NotFinite {
            field: "center_of_gravity_m",
        });
    }
    if !payload.inertia_kg_m2.iter().flatten().all(|v| v.is_finite()) {
        return Err(BridgeError::NotFinite {
            field: "inertia_kg_m2",
        });
    }

    let m = &payload.inertia_kg_m2;

    let mut metadata = std::collections::BTreeMap::new();
    // The model's frame fields are non-optional in the schema, so presence cannot
    // distinguish a deliberate choice from a serde default. This flag can.
    metadata.insert(
        "frame_confirmed".to_string(),
        serde_json::Value::Bool(true),
    );
    metadata.insert(
        "source".to_string(),
        serde_json::json!({
            "platform_type": MASS_PROPERTIES_TYPE,
            "original_units": payload.source_units.as_str(),
            "note": payload.source_note,
        }),
    );

    Ok(hex_model::ModelDocument {
        schema_version: hex_model::SCHEMA_VERSION.to_string(),
        model_id: model_id.to_string(),
        model_version: "1.0".to_string(),
        name: name.to_string(),
        description: Some(format!(
            "Assembled from platform artifacts. Mass properties published by the CAD \
             application (originally {}).",
            payload.source_units.as_str()
        )),
        frame: hex_model::FrameDocument {
            // Declared deliberately; see DESIGN.md on conventions that cannot be inferred.
            world: hex_core::WorldFrame::Enu,
            body: hex_core::BodyFrame::ForwardRightDown,
        },
        reference_geometry: hex_model::ReferenceGeometryDocument {
            reference_area: reference.reference_area_m2,
            reference_length: reference.reference_length_m,
            body_diameter: reference.body_diameter_m,
        },
        mass_properties: hex_model::MassPropertiesDocument {
            mass: payload.mass_kg,
            center_of_gravity: hex_core::Vec3Record::new(
                payload.center_of_gravity_m[0],
                payload.center_of_gravity_m[1],
                payload.center_of_gravity_m[2],
            ),
            inertia: hex_model::InertiaDocument {
                ixx: m[0][0],
                ixy: m[0][1],
                ixz: m[0][2],
                iyx: m[1][0],
                iyy: m[1][1],
                iyz: m[1][2],
                izx: m[2][0],
                izy: m[2][1],
                izz: m[2][2],
            },
            mass_curve: None,
        },
        mesh: None,
        thrust: None,
        aerodynamics: None,
        metadata,
    })
}
