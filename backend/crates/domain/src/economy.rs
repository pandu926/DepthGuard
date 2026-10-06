use crate::money::{Atomic, public_key};
use num_bigint::BigUint;
use num_traits::{ToPrimitive, Zero};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const ENGINE_VERSION: &str = "depthguard-rust-0.1.0";
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mechanism {
    Meme,
    Funding,
    Backed,
    AssetQuote,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    pub sqrt_price: Atomic,
    pub liquidity: Atomic,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeePolicy {
    pub author: String,
    pub launcher_bps: u16,
    pub author_bps: u16,
    pub platform_bps: u16,
}
impl FeePolicy {
    /// Rounding remainder stays with the launcher; principal is never a fee stream.
    pub fn allocate(&self, claimable: u64) -> Result<[u64; 3], String> {
        self.validate()?;
        let author = (u128::from(claimable) * u128::from(self.author_bps) / 10_000) as u64;
        let platform = (u128::from(claimable) * u128::from(self.platform_bps) / 10_000) as u64;
        Ok([claimable - author - platform, author, platform])
    }
    fn validate(&self) -> Result<(), String> {
        public_key(&self.author)?;
        if u32::from(self.launcher_bps) + u32::from(self.author_bps) + u32::from(self.platform_bps)
            != 10_000
            || self.author_bps == 0
            || self.platform_bps == 0
            || self.launcher_bps == 0
        {
            return Err("Fee shares must be positive and sum to 10000 basis points".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MilestoneTerms {
    pub weight_bps: u16,
    pub deadline_offset: Atomic,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModuleTerms {
    pub reviewer_threshold: u8,
    pub milestones: Vec<MilestoneTerms>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Economy {
    pub schema_version: u16,
    pub mechanism: Mechanism,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub supply: Atomic,
    pub sqrt_start_price: Atomic,
    pub curve: Vec<Segment>,
    pub migration_quote_threshold: Atomic,
    pub trade_fee_bps: u16,
    pub migration_fee_pct: u8,
    pub compounding_fee_bps: u16,
    pub fee_policy: FeePolicy,
    /// Full native arguments retained for expert research. They do not bypass validation.
    #[serde(default)]
    pub native_config: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module: Option<ModuleTerms>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Validation {
    pub valid: bool,
    pub issues: Vec<String>,
    pub capability: String,
    pub gates: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Compiled {
    pub economy: Economy,
    pub content_hash: String,
    pub engine_version: String,
    pub validation: Validation,
    pub curve_quote_capacity: Atomic,
    pub curve_base_capacity: Atomic,
    pub terminal_sqrt_price: Atomic,
    pub migration_allocation: Atomic,
    pub protocol_migration_fee: Atomic,
    pub pool_quote: Atomic,
}
fn narrow(n: BigUint) -> Result<u128, String> {
    n.to_u128()
        .ok_or_else(|| "Derived amount exceeds u128".into())
}
pub fn div_up(n: BigUint, d: BigUint) -> BigUint {
    (&n + &d - BigUint::from(1u8)) / d
}
impl Economy {
    pub fn validate(&self) -> Validation {
        let mut issues = Vec::new();
        if ![1, 2].contains(&self.schema_version) {
            issues.push("Unsupported schema version".into());
        }
        if self.schema_version == 1 && self.module.is_some() {
            issues.push("Module terms require schema version two".into());
        }
        if self.schema_version == 2 {
            match (&self.mechanism, &self.module) {
                (Mechanism::Funding, Some(m)) => {
                    let mut sum = 0u32;
                    let mut previous = 0u128;
                    if !(2..=3).contains(&m.reviewer_threshold)
                        || m.milestones.is_empty()
                        || m.milestones.len() > 16
                    {
                        issues.push("Invalid milestone policy".into());
                    }
                    for milestone in &m.milestones {
                        if milestone.weight_bps == 0
                            || milestone.deadline_offset.0 <= previous
                            || milestone.deadline_offset.0 > 315_360_000
                        {
                            issues.push("Invalid milestone schedule".into());
                        }
                        previous = milestone.deadline_offset.0;
                        sum += u32::from(milestone.weight_bps);
                    }
                    if sum != 10000 {
                        issues.push("Milestone shares must total 10000 basis points".into());
                    }
                }
                (Mechanism::Backed, Some(m))
                    if m.reviewer_threshold == 0 && m.milestones.is_empty() => {}
                (Mechanism::Meme | Mechanism::AssetQuote, None) => {}
                _ => issues.push("Module terms do not match the mechanism".into()),
            }
        }
        if !(6..=9).contains(&self.base_decimals) || self.quote_decimals > 9 {
            issues.push("Unsupported mint decimals".into());
        }
        if self.supply.0 == 0
            || self.supply.0 > u64::MAX as u128
            || self.migration_quote_threshold.0 == 0
            || self.migration_quote_threshold.0 > u64::MAX as u128
        {
            issues.push("Supply and threshold must be positive u64 atomic amounts".into());
        }
        if self.curve.is_empty() || self.curve.len() > 16 {
            issues.push("DBC requires 1 to 16 segments".into());
        }
        let mut previous = self.sqrt_start_price.0;
        if !(4295048016..=79226673521066979257578248091).contains(&previous) {
            issues.push("Starting square root price exceeds native DBC bounds".into());
        }
        for (i, segment) in self.curve.iter().enumerate() {
            if segment.sqrt_price.0 <= previous
                || segment.sqrt_price.0 > 79226673521066979257578248091
                || segment.liquidity.0 == 0
            {
                issues.push(format!(
                    "Segment {i} requires increasing prices and positive liquidity"
                ));
            }
            previous = segment.sqrt_price.0;
        }
        if !(25..=9900).contains(&self.trade_fee_bps) {
            issues.push("DBC trade fee must be between 25 and 9900 basis points".into());
        }
        if self.migration_fee_pct > 99 || self.compounding_fee_bps > 10_000 {
            issues.push("Invalid migration or compounding fee".into());
        }
        if let Err(e) = self.fee_policy.validate() {
            issues.push(e);
        }
        // Capabilities describe actual implementation evidence, not business promises.
        let mut gates = vec![
            "Native instruction and target-program parity verification required before deployment"
                .into(),
        ];
        if matches!(self.mechanism, Mechanism::Funding) {
            gates
                .push("Milestone escrow, refunds and approvals require a separate contract".into());
        }
        if matches!(self.mechanism, Mechanism::Backed) {
            gates.push("Burn redemption and reserve custody require a separate contract".into());
        }
        if matches!(self.mechanism, Mechanism::AssetQuote) {
            gates.push(
                "Quote mint compatibility and external asset rights require verification".into(),
            );
        }
        if self.native_config.is_some() {
            issues.push("Expert native configurations require the native validation endpoint; this analytical compiler does not execute additional native fields".into());
            gates.push(
                "Expert native fields require pinned IDL validation and program execution parity"
                    .into(),
            );
        }
        Validation {
            valid: issues.is_empty(),
            issues,
            capability: "research_only".into(),
            gates,
        }
    }
    pub fn compile(&self) -> Result<Compiled, Vec<String>> {
        let validation = self.validate();
        if !validation.valid {
            return Err(validation.issues);
        }
        let compute = || -> Result<Compiled, String> {
            let q128 = BigUint::from(1u8) << 128;
            let mut quote = BigUint::zero();
            let mut base = BigUint::zero();
            let mut price = BigUint::from(self.sqrt_start_price.0);
            let mut remaining = BigUint::from(self.migration_quote_threshold.0);
            let mut terminal = price.clone();
            for s in &self.curve {
                let high = BigUint::from(s.sqrt_price.0);
                let liquidity = BigUint::from(s.liquidity.0);
                let delta = &high - &price;
                let segment_quote = &liquidity * &delta / &q128;
                quote += &segment_quote;
                base += div_up(&liquidity * &delta, &high * &price);
                if !remaining.is_zero() {
                    if remaining <= segment_quote {
                        terminal = &price + div_up(&remaining * &q128, liquidity);
                        remaining = BigUint::zero();
                    } else {
                        remaining -= segment_quote;
                        terminal = high.clone();
                    }
                }
                price = high;
            }
            if !remaining.is_zero() {
                return Err("Migration threshold exceeds curve capacity".into());
            }
            if base > BigUint::from(self.supply.0) {
                return Err("Curve allocation exceeds total supply".into());
            }
            let principal =
                self.migration_quote_threshold.0 * u128::from(self.migration_fee_pct) / 100;
            let retained = self.migration_quote_threshold.0 - principal;
            // Pinned analytical assumption: 20 bps of retained quote, rounded down.
            let protocol = retained * 20 / 10_000;
            let value = serde_json::to_value(self).map_err(|e| e.to_string())?;
            Ok(Compiled {
                economy: self.clone(),
                content_hash: hash_value(&value),
                engine_version: ENGINE_VERSION.into(),
                validation,
                curve_quote_capacity: Atomic(narrow(quote)?),
                curve_base_capacity: Atomic(narrow(base)?),
                terminal_sqrt_price: Atomic(narrow(terminal)?),
                migration_allocation: Atomic(principal),
                protocol_migration_fee: Atomic(protocol),
                pool_quote: Atomic(retained - protocol),
            })
        };
        compute().map_err(|e| vec![e])
    }
}
/// Canonical JSON sorts object keys recursively; floats are forbidden in economy schemas.
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("JSON key"),
                        canonical(&map[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        other => other.to_string(),
    }
}
pub fn hash_value(value: &Value) -> String {
    hex::encode(Sha256::digest(canonical(value)))
}

impl Economy {
    /// Restricted native launch profile. Expert fields use a separate validation and research path.
    pub fn native_parameters(&self) -> Result<Value, String> {
        self.parameters_for(false)
    }
    pub fn contract_native_parameters(&self) -> Result<Value, String> {
        self.parameters_for(true)
    }
    fn parameters_for(&self, contract: bool) -> Result<Value, String> {
        self.compile().map_err(|e| e.join("; "))?;
        if !contract && matches!(self.mechanism, Mechanism::Funding | Mechanism::Backed) {
            return Err(
                "This mechanism requires an extension contract before native launch".into(),
            );
        }
        if !contract && self.migration_fee_pct != 0 {
            return Err(
                "Migration allocations require a separately verified capital-withdrawal workflow"
                    .into(),
            );
        }
        if contract
            && matches!(self.mechanism, Mechanism::Funding | Mechanism::Backed)
            && (self.schema_version != 2 || self.migration_fee_pct == 0)
        {
            return Err(
                "Contract capital mechanisms require version two and positive migration allocation"
                    .into(),
            );
        }
        if contract
            && matches!(self.mechanism, Mechanism::Meme | Mechanism::AssetQuote)
            && self.migration_fee_pct != 0
        {
            return Err("Trading-only mechanisms cannot allocate migration capital".into());
        }
        if self.trade_fee_bps > 1000 {
            return Err("Migrated DAMM custom fees cannot exceed 1000 basis points".into());
        }
        let vesting = json!({"vesting_percentage":0,"bps_per_period":0,"number_of_periods":0,"cliff_duration_from_migration_time":0,"frequency":0});
        let params = json!({
            "pool_fees":{"base_fee":{"cliff_fee_numerator":(u64::from(self.trade_fee_bps)*100000).to_string(),"first_factor":0,"second_factor":"0","third_factor":"0","base_fee_mode":0},"dynamic_fee":null},
            "collect_fee_mode":0,"migration_option":1,"activation_type":1,"token_type":0,"token_decimal":self.base_decimals,
            "partner_liquidity_percentage":0,"partner_permanent_locked_liquidity_percentage":100,"creator_liquidity_percentage":0,"creator_permanent_locked_liquidity_percentage":0,
            "migration_quote_threshold":self.migration_quote_threshold,"sqrt_start_price":self.sqrt_start_price,
            "locked_vesting":{"amount_per_period":"0","cliff_duration_from_migration_time":"0","frequency":"0","number_of_period":"0","cliff_unlock_amount":"0"},
            "migration_fee_option":6,"token_supply":{"pre_migration_token_supply":self.supply,"post_migration_token_supply":self.supply},
            "creator_trading_fee_percentage":0,"token_update_authority":1,"migration_fee":{"fee_percentage":self.migration_fee_pct,"creator_fee_percentage":if contract && self.migration_fee_pct>0 {100}else{0}},
            "migrated_pool_fee":{"collect_fee_mode":if self.compounding_fee_bps>0{2}else{0},"dynamic_fee":0,"pool_fee_bps":self.trade_fee_bps},
            "pool_creation_fee":"0","partner_liquidity_vesting_info":vesting,"creator_liquidity_vesting_info":vesting,
            "migrated_pool_base_fee_mode":0,"migrated_pool_market_cap_fee_scheduler_params":{"number_of_period":0,"sqrt_price_step_bps":0,"scheduler_expiration_duration":0,"reduction_factor":"0"},
            "enable_first_swap_with_min_fee":false,"compounding_fee_bps":self.compounding_fee_bps,"padding":[0,0],
            "curve":self.curve.iter().map(|s|json!({"sqrt_price":s.sqrt_price,"liquidity":s.liquidity})).collect::<Vec<_>>()
        });
        crate::native::encode("dbc", "ConfigParameters", &params)?;
        Ok(params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Economy {
        serde_json::from_value(json!({"schema_version":1,"mechanism":"meme","base_decimals":6,"quote_decimals":9,"supply":"1000000000000000","sqrt_start_price":"184467440737095516","curve":[{"sqrt_price":"1844674407370955160","liquidity":"1000000000000"}],"migration_quote_threshold":"1000000000","trade_fee_bps":25,"migration_fee_pct":0,"compounding_fee_bps":0,"fee_policy":{"author":"11111111111111111111111111111111","launcher_bps":8000,"author_bps":1000,"platform_bps":1000}})).unwrap()
    }
    #[test]
    fn schema_one_serialization_preserves_existing_hash_shape() {
        let e = fixture();
        let value = serde_json::to_value(&e).unwrap();
        assert!(value.get("module").is_none());
        let round_trip: Economy = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            hash_value(&value),
            hash_value(&serde_json::to_value(round_trip).unwrap())
        );
    }
    #[test]
    fn module_terms_reject_missing_invalid_and_legacy_policies() {
        let mut e = fixture();
        e.module = Some(ModuleTerms {
            reviewer_threshold: 2,
            milestones: vec![MilestoneTerms {
                weight_bps: 10000,
                deadline_offset: Atomic(100),
            }],
        });
        assert!(
            e.validate()
                .issues
                .iter()
                .any(|i| i.contains("schema version two"))
        );
        e.schema_version = 2;
        e.mechanism = Mechanism::Funding;
        e.module = None;
        assert!(
            e.validate()
                .issues
                .iter()
                .any(|i| i.to_ascii_lowercase().contains("module"))
        );
        e.module = Some(ModuleTerms {
            reviewer_threshold: 1,
            milestones: vec![MilestoneTerms {
                weight_bps: 9999,
                deadline_offset: Atomic(0),
            }],
        });
        let errors = e.validate().issues;
        assert!(errors.iter().any(|i| i.contains("milestone")));
    }
    #[test]
    fn royalty_conservation_for_maximum_amount() {
        let p = FeePolicy {
            author: "11111111111111111111111111111111".into(),
            launcher_bps: 8000,
            author_bps: 1000,
            platform_bps: 1000,
        };
        for amount in [0, 1, 9, 10, 999, u64::MAX] {
            assert_eq!(
                p.allocate(amount)
                    .unwrap()
                    .iter()
                    .map(|x| u128::from(*x))
                    .sum::<u128>(),
                u128::from(amount)
            );
        }
    }
    #[test]
    fn canonical_hash_ignores_key_order() {
        assert_eq!(
            hash_value(&serde_json::json!({"z":1,"a":{"b":2,"a":1}})),
            hash_value(&serde_json::json!({"a":{"a":1,"b":2},"z":1}))
        );
    }
}
