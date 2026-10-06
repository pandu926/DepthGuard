use crate::money::public_key;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn catalog() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/research/native-parameter-schema.json"
    ))
    .expect("Pinned catalog")
}
/// IDL structural validation and Borsh encoding share one traversal. Semantic certification is separate.
pub fn encode(protocol: &str, root: &str, input: &Value) -> Result<Vec<u8>, String> {
    let catalog = catalog();
    let snapshot = catalog["snapshots"]
        .as_array()
        .ok_or("Catalog snapshots missing")?
        .iter()
        .find(|s| s["protocol"] == protocol)
        .ok_or("Unknown protocol")?;
    if !snapshot["roots"]
        .as_array()
        .ok_or("Catalog roots missing")?
        .iter()
        .any(|r| r == root)
    {
        return Err("Unsupported native root type".into());
    }
    let types: BTreeMap<String, Value> = snapshot["types"]
        .as_array()
        .ok_or("Catalog types missing")?
        .iter()
        .map(|t| (t["name"].as_str().unwrap_or("").into(), t["type"].clone()))
        .collect();
    let mut out = Vec::new();
    walk(
        &json!({"defined":{"name":root}}),
        input,
        &types,
        root,
        0,
        &mut out,
    )?;
    if protocol == "dbc" && root == "ConfigParameters" {
        dbc_constraints(input)?;
    }
    Ok(out)
}
fn walk(
    ty: &Value,
    input: &Value,
    types: &BTreeMap<String, Value>,
    path: &str,
    depth: usize,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    if depth > 32 {
        return Err(format!("{path}: maximum nesting depth exceeded"));
    }
    let error = |s: &str| format!("{path}: {s}");
    if let Some(t) = ty.as_str() {
        if let Some(bits) = t.strip_prefix('u').and_then(|s| s.parse::<usize>().ok()) {
            if ![8, 16, 32, 64, 128].contains(&bits) {
                return Err(error("Unsupported integer width"));
            }
            let n = if bits >= 64 {
                let s = input
                    .as_str()
                    .ok_or_else(|| error("Large integers must be decimal strings"))?;
                if s.is_empty()
                    || !s.bytes().all(|c| c.is_ascii_digit())
                    || (s.len() > 1 && s.starts_with('0'))
                {
                    return Err(error("Noncanonical unsigned integer"));
                }
                s.parse::<u128>()
                    .map_err(|_| error("Integer out of range"))?
            } else {
                u128::from(
                    input
                        .as_u64()
                        .ok_or_else(|| error("Expected unsigned integer"))?,
                )
            };
            if bits < 128 && n >= 1u128 << bits {
                return Err(error("Integer exceeds native width"));
            }
            out.extend_from_slice(&n.to_le_bytes()[..bits / 8]);
            return Ok(());
        }
        match t {
            "bool" => out.push(u8::from(
                input.as_bool().ok_or_else(|| error("Expected boolean"))?,
            )),
            "pubkey" => out.extend_from_slice(&public_key(
                input.as_str().ok_or_else(|| error("Expected public key"))?,
            )?),
            "string" => {
                let s = input.as_str().ok_or_else(|| error("Expected string"))?;
                if s.len() > 4096 {
                    return Err(error("String exceeds limit"));
                }
                out.extend_from_slice(&(s.len() as u32).to_le_bytes());
                out.extend_from_slice(s.as_bytes());
            }
            _ => return Err(error("Unsupported native type")),
        }
        return Ok(());
    }
    if let Some(name) = ty.pointer("/defined/name").and_then(Value::as_str) {
        let def = types
            .get(name)
            .ok_or_else(|| error("Defined type missing from snapshot"))?;
        match def["kind"].as_str() {
            Some("struct") => {
                let object = input.as_object().ok_or_else(|| error("Expected object"))?;
                let fields = def["fields"]
                    .as_array()
                    .ok_or_else(|| error("Struct fields missing"))?;
                for key in object.keys() {
                    if !fields.iter().any(|f| f["name"] == *key) {
                        return Err(error(&format!("Unknown field {key}")));
                    }
                }
                for field in fields {
                    let name = field["name"]
                        .as_str()
                        .ok_or_else(|| error("Missing field name"))?;
                    let value = object
                        .get(name)
                        .ok_or_else(|| error(&format!("Missing field {name}")))?;
                    walk(
                        &field["type"],
                        value,
                        types,
                        &format!("{path}.{name}"),
                        depth + 1,
                        out,
                    )?;
                }
            }
            Some("enum") => {
                let variants = def["variants"]
                    .as_array()
                    .ok_or_else(|| error("Enum variants missing"))?;
                let name = input
                    .as_str()
                    .or_else(|| input.get("variant").and_then(Value::as_str))
                    .ok_or_else(|| error("Expected enum variant"))?;
                let index = variants
                    .iter()
                    .position(|v| v["name"] == name)
                    .ok_or_else(|| error("Unknown enum variant"))?;
                out.push(u8::try_from(index).map_err(|_| error("Too many enum variants"))?);
                if variants[index].get("fields").is_some() {
                    return Err(error("Payload enum encoding is not supported"));
                }
            }
            _ => return Err(error("Unsupported defined type")),
        }
    } else if let Some(inner) = ty.get("option") {
        if input.is_null() {
            out.push(0);
        } else {
            out.push(1);
            walk(inner, input, types, path, depth + 1, out)?;
        }
    } else if let Some(inner) = ty.get("vec") {
        let values = input.as_array().ok_or_else(|| error("Expected array"))?;
        if values.len() > 1024 {
            return Err(error("Vector exceeds limit"));
        }
        out.extend_from_slice(&(values.len() as u32).to_le_bytes());
        for (i, v) in values.iter().enumerate() {
            walk(inner, v, types, &format!("{path}[{i}]"), depth + 1, out)?;
        }
    } else if let Some(array) = ty.get("array").and_then(Value::as_array) {
        let length = array[1]
            .as_u64()
            .ok_or_else(|| error("Invalid fixed array length"))? as usize;
        let values = input
            .as_array()
            .ok_or_else(|| error("Expected fixed array"))?;
        if values.len() != length {
            return Err(error("Fixed array length mismatch"));
        }
        for (i, v) in values.iter().enumerate() {
            walk(&array[0], v, types, &format!("{path}[{i}]"), depth + 1, out)?;
        }
    } else {
        return Err(error("Unsupported IDL type expression"));
    }
    Ok(())
}
fn dbc_constraints(v: &Value) -> Result<(), String> {
    let raw = |p: &str| -> Result<u128, String> {
        v.pointer(p)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Missing native amount {p}"))?
            .parse()
            .map_err(|_| format!("Invalid amount {p}"))
    };
    let small = |p: &str| -> Result<u64, String> {
        v.pointer(p)
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("Missing native field {p}"))
    };
    let mut prior = raw("/sqrt_start_price")?;
    if !(4295048016..=79226673521066979257578248091).contains(&prior) {
        return Err("Starting price exceeds DBC bounds".into());
    }
    let curve = v["curve"].as_array().ok_or("Curve missing")?;
    if curve.is_empty() || curve.len() > 16 {
        return Err("DBC requires 1 to 16 curve segments".into());
    }
    for s in curve {
        let price: u128 = s["sqrt_price"]
            .as_str()
            .ok_or("Missing segment price")?
            .parse()
            .map_err(|_| "Invalid segment price")?;
        let liquidity: u128 = s["liquidity"]
            .as_str()
            .ok_or("Missing liquidity")?
            .parse()
            .map_err(|_| "Invalid liquidity")?;
        if price <= prior || price > 79226673521066979257578248091 || liquidity == 0 {
            return Err(
                "Curve prices must increase within native bounds with positive liquidity".into(),
            );
        }
        prior = price;
    }
    if raw("/migration_quote_threshold")? == 0 {
        return Err("Migration threshold must be positive".into());
    }
    if small("/migration_option")? != 1 {
        return Err("New launch requires DAMM v2 migration".into());
    }
    let bps = raw("/pool_fees/base_fee/cliff_fee_numerator")? / 100_000;
    if !(25..=9900).contains(&bps) {
        return Err("DBC base fee must be 25 to 9900 bps".into());
    }
    let sum = [
        "partner_liquidity_percentage",
        "partner_permanent_locked_liquidity_percentage",
        "creator_liquidity_percentage",
        "creator_permanent_locked_liquidity_percentage",
    ]
    .iter()
    .map(|f| small(&format!("/{f}")))
    .collect::<Result<Vec<_>, _>>()?
    .iter()
    .sum::<u64>();
    // Locked vesting percentages are accounted for when the target IDL includes them.
    let vesting_sum = [
        "partner_liquidity_vesting_info",
        "creator_liquidity_vesting_info",
    ]
    .iter()
    .filter_map(|f| v.get(f)?.get("vesting_percentage")?.as_u64())
    .sum::<u64>();
    if sum + vesting_sum != 100 {
        return Err("LP ownership buckets must sum to 100 percent".into());
    }
    if small("/migration_fee/fee_percentage")? > 99
        || small("/migration_fee/creator_fee_percentage")? > 100
    {
        return Err("Invalid migration fee distribution".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_integer_width_and_no_unknown_fields() {
        let types = BTreeMap::new();
        let mut out = vec![];
        assert!(
            walk(
                &json!("u64"),
                &json!(9007199254740993u64),
                &types,
                "a",
                0,
                &mut out
            )
            .is_err()
        );
        walk(
            &json!("u64"),
            &json!("9007199254740993"),
            &types,
            "a",
            0,
            &mut out,
        )
        .unwrap();
        assert_eq!(out, 9007199254740993u64.to_le_bytes());
        assert!(walk(&json!("u8"), &json!(256), &types, "a", 0, &mut out).is_err());
    }
}
