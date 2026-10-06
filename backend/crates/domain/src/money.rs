use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Atomic units are decimal strings on the wire. JSON numbers are deliberately rejected.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Atomic(pub u128);
impl Serialize for Atomic {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for Atomic {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        if s.is_empty()
            || s.len() > 39
            || !s.bytes().all(|c| c.is_ascii_digit())
            || (s.len() > 1 && s.starts_with('0'))
        {
            return Err(serde::de::Error::custom(
                "Expected a canonical unsigned decimal string",
            ));
        }
        s.parse().map(Self).map_err(serde::de::Error::custom)
    }
}
impl fmt::Display for Atomic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

pub fn public_key(value: &str) -> Result<[u8; 32], String> {
    if !(32..=44).contains(&value.len()) {
        return Err("Invalid public key length".into());
    }
    bs58::decode(value)
        .into_vec()
        .map_err(|_| "Invalid base58 public key".to_owned())?
        .try_into()
        .map_err(|_| "Public key must contain exactly 32 bytes".to_owned())
}

impl schemars::JsonSchema for Atomic {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Atomic".into()
    }
    fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({"type":"string","pattern":"^(0|[1-9][0-9]{0,38})$","description":"Canonical unsigned decimal atomic units; maximum u128, further restricted by native widths"})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn precision_and_canonical_encoding() {
        let n = Atomic(u128::MAX);
        assert_eq!(
            serde_json::from_str::<Atomic>(&serde_json::to_string(&n).unwrap()).unwrap(),
            n
        );
        for bad in [
            "1",
            "\"01\"",
            "\"-1\"",
            "\"1.0\"",
            "\"340282366920938463463374607431768211456\"",
        ] {
            assert!(serde_json::from_str::<Atomic>(bad).is_err());
        }
    }
}
