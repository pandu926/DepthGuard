use depthguard_domain::{
    economy::{Compiled, ENGINE_VERSION, Economy, div_up},
    money::Atomic,
};
use num_bigint::BigUint;
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Scenario {
    SingleSwap,
    FullCurve,
    Graduation,
    WhaleSell,
    SequentialTrading,
    FeeSchedule,
    Compounding,
    AdditionalCapital,
    VestingLock,
    Funding,
    Redemption,
    RoyaltyFork,
    AssetQuote,
    HistoricalReplay,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Order {
    pub direction: Direction,
    pub amount: Atomic,
    #[serde(default)]
    pub exact_out: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Buy,
    Sell,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub scenario: Scenario,
    pub economy: Economy,
    #[serde(default)]
    pub orders: Vec<Order>,
    #[serde(default)]
    pub inputs: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResearchRequest {
    pub evidence: String,
    pub seed: String,
    pub clock: u64,
    pub cases: Vec<Case>,
    #[serde(default)]
    pub frozen_paths: Vec<String>,
}
impl ResearchRequest {
    pub fn validate(&self) -> Result<(), String> {
        if !["analytical", "sdk_quote", "local_sbf"].contains(&self.evidence.as_str()) {
            return Err("Unsupported evidence level".into());
        }
        let limit = if self.evidence == "local_sbf" {
            100
        } else {
            1000
        };
        if self.cases.is_empty() || self.cases.len() > limit {
            return Err(format!(
                "Research requires 1 to {limit} cases for this evidence level"
            ));
        }
        if self.evidence != "analytical"
            && self
                .cases
                .iter()
                .any(|c| !c.inputs.get("snapshot").is_some_and(Value::is_object))
        {
            return Err(
                "Native research requires a recorded account snapshot for every case".into(),
            );
        }
        if self.evidence == "sdk_quote"
            && self.cases.iter().any(|case| {
                let op = case.inputs["snapshot"]["operation"].as_str();
                op.is_some_and(|op| op != "quote")
            })
        {
            return Err("SDK research accepts quote snapshots only".into());
        }
        if self.seed.len() > 128 {
            return Err("Seed is too long".into());
        }
        for case in &self.cases {
            if case.orders.len() > 1000 {
                return Err("A case cannot exceed 1000 orders".into());
            }
        }
        for path in &self.frozen_paths {
            if !path.starts_with('/') {
                return Err("Frozen paths must use JSON Pointer syntax".into());
            }
            let first = serde_json::to_value(&self.cases[0].economy).map_err(|e| e.to_string())?;
            let expected = first.pointer(path).ok_or("Frozen path does not exist")?;
            for case in &self.cases[1..] {
                let value = serde_json::to_value(&case.economy).map_err(|e| e.to_string())?;
                if value.pointer(path) != Some(expected) {
                    return Err(format!("Frozen constraint differs across cases: {path}"));
                }
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
struct CurveState {
    sqrt: u128,
    reserve: u128,
    fees: u128,
}
fn to_u128(v: BigUint) -> Result<u128, String> {
    v.to_u128().ok_or_else(|| "Arithmetic overflow".into())
}
fn floor_fee(gross: u128, bps: u16) -> Result<u128, String> {
    to_u128(BigUint::from(gross) * BigUint::from(bps) / BigUint::from(10_000u32))
}
/// Piecewise Q64.64 integration. This is an analytical implementation, not a native receipt.
fn exact_in(
    c: &Compiled,
    state: &mut CurveState,
    direction: Direction,
    amount: u128,
) -> Result<Value, String> {
    if amount == 0 || amount > u64::MAX as u128 {
        return Err("Input must be a positive u64 amount".into());
    }
    let mut next = state.clone();
    let q128: BigUint = BigUint::from(1u8) << 128usize;
    let mut remaining = amount;
    let mut output = 0u128;
    let mut input_fee = 0u128;
    let buy = matches!(direction, Direction::Buy);
    if buy {
        input_fee = floor_fee(amount, c.economy.trade_fee_bps)?;
        remaining -= input_fee;
    }
    while remaining > 0 {
        let (low, high, liquidity) =
            if buy {
                let mut previous = c.economy.sqrt_start_price.0;
                c.economy
                    .curve
                    .iter()
                    .find_map(|s| {
                        let result = (next.sqrt < s.sqrt_price.0).then_some((
                            previous,
                            s.sqrt_price.0.min(c.terminal_sqrt_price.0),
                            s.liquidity.0,
                        ));
                        previous = s.sqrt_price.0;
                        result
                    })
                    .ok_or("Curve exhausted")?
            } else {
                let mut previous = c.economy.sqrt_start_price.0;
                c.economy
                    .curve
                    .iter()
                    .find_map(|s| {
                        let result = (next.sqrt > previous && next.sqrt <= s.sqrt_price.0)
                            .then_some((previous, s.sqrt_price.0, s.liquidity.0));
                        previous = s.sqrt_price.0;
                        result
                    })
                    .ok_or("Insufficient quote liquidity")?
            };
        let s = BigUint::from(next.sqrt);
        let l = BigUint::from(liquidity);
        if buy {
            if high <= next.sqrt {
                return Err(
                    "Graduation threshold reached; unused input must be handled explicitly".into(),
                );
            }
            let required = to_u128(div_up(&l * BigUint::from(high - next.sqrt), q128.clone()))?;
            let used = remaining.min(required);
            let target = if used == required {
                high
            } else {
                to_u128(&s + BigUint::from(used) * &q128 / &l)?
            };
            let produced =
                to_u128(&l * BigUint::from(target - next.sqrt) / (&s * BigUint::from(target)))?;
            output = output.checked_add(produced).ok_or("Output overflow")?;
            next.reserve = next.reserve.checked_add(used).ok_or("Reserve overflow")?;
            next.sqrt = target;
            remaining -= used;
        } else {
            let required = to_u128(div_up(
                &l * BigUint::from(next.sqrt - low),
                &s * BigUint::from(low),
            ))?;
            let used = remaining.min(required);
            let target = if used == required {
                low
            } else {
                to_u128(div_up(&l * &s, &l + BigUint::from(used) * &s))?
            };
            let produced = to_u128(&l * BigUint::from(next.sqrt - target) / &q128)?;
            next.reserve = next
                .reserve
                .checked_sub(produced)
                .ok_or("Insufficient funded quote reserve")?;
            output = output.checked_add(produced).ok_or("Output overflow")?;
            next.sqrt = target;
            remaining -= used;
        }
        if next.sqrt == state.sqrt && output == 0 {
            return Err("Amount is below curve rounding precision".into());
        }
    }
    let output_fee = if buy {
        0
    } else {
        floor_fee(output, c.economy.trade_fee_bps)?
    };
    let fee = input_fee + output_fee;
    next.fees = next
        .fees
        .checked_add(fee)
        .ok_or("Fee accumulator overflow")?;
    let result = json!({"input":Atomic(amount),"gross_output":Atomic(output),"output":Atomic(output-output_fee),"fee":Atomic(fee),"sqrt_price":Atomic(next.sqrt),"quote_reserve":Atomic(next.reserve)});
    *state = next;
    Ok(result)
}
fn swap(c: &Compiled, state: &mut CurveState, order: &Order) -> Result<Value, String> {
    if !order.exact_out {
        return exact_in(c, state, order.direction, order.amount.0);
    }
    if order.amount.0 == 0 || order.amount.0 > u64::MAX as u128 {
        return Err("Output must be a positive u64 amount".into());
    }
    let mut lo = 1u128;
    let mut hi = 1u128;
    let output_at = |amount| -> Option<u128> {
        let mut trial = state.clone();
        exact_in(c, &mut trial, order.direction, amount)
            .ok()?
            .get("output")?
            .as_str()?
            .parse()
            .ok()
    };
    // A doubling step can overshoot a finite curve before bracketing a reachable output.
    // Search the last interval for its largest feasible input before declaring exhaustion.
    let mut last_feasible = 0;
    loop {
        match output_at(hi) {
            Some(out) if out >= order.amount.0 => break,
            Some(_) => last_feasible = hi,
            None if last_feasible > 0 => {
                let mut left = last_feasible;
                let mut right = hi;
                while left + 1 < right {
                    let mid = left + (right - left) / 2;
                    if output_at(mid).is_some() {
                        left = mid;
                    } else {
                        right = mid;
                    }
                }
                hi = left;
                break;
            }
            None => {}
        }
        if hi == u128::from(u64::MAX) {
            break;
        }
        hi = (hi * 2).min(u128::from(u64::MAX));
    }
    if output_at(hi).is_none_or(|out| out < order.amount.0) {
        return Err("Requested output exceeds available liquidity".into());
    }
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if output_at(mid).is_some_and(|out| out >= order.amount.0) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    let mut result = exact_in(c, state, order.direction, lo)?;
    result["requested_output"] = json!(order.amount);
    result["rounding_surplus"] = json!(Atomic(
        result["output"]
            .as_str()
            .unwrap_or("0")
            .parse::<u128>()
            .unwrap_or(0)
            - order.amount.0
    ));
    Ok(result)
}
fn raw(inputs: &Value, key: &str) -> Result<u128, String> {
    let value = inputs
        .get(key)
        .ok_or_else(|| format!("Missing input: {key}"))?;
    serde_json::from_value::<Atomic>(value.clone())
        .map(|n| n.0)
        .map_err(|e| e.to_string())
}
pub fn run_case(case: &Case, seed: &str, clock: u64) -> Value {
    let compiled = match case.economy.compile() {
        Ok(c) => c,
        Err(errors) => return json!({"status":"invalid","issues":errors,"evidence":"analytical"}),
    };
    let run = || -> Result<Value, String> {
        match case.scenario {
            Scenario::FullCurve | Scenario::Graduation => Ok(
                json!({"compiled":compiled,"principal_conserved":compiled.migration_allocation.0+compiled.protocol_migration_fee.0+compiled.pool_quote.0 == compiled.economy.migration_quote_threshold.0}),
            ),
            Scenario::SingleSwap
            | Scenario::SequentialTrading
            | Scenario::WhaleSell
            | Scenario::HistoricalReplay => {
                let sqrt = case
                    .inputs
                    .get("sqrt_price")
                    .map(|v| serde_json::from_value::<Atomic>(v.clone()))
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .map_or(case.economy.sqrt_start_price.0, |v| v.0);
                if sqrt < case.economy.sqrt_start_price.0 || sqrt > compiled.terminal_sqrt_price.0 {
                    return Err("Initial price lies outside the funded curve".into());
                }
                let reserve = case
                    .inputs
                    .get("quote_reserve")
                    .map(|v| serde_json::from_value::<Atomic>(v.clone()))
                    .transpose()
                    .map_err(|e| e.to_string())?
                    .map_or(0, |v| v.0);
                let mut state = CurveState {
                    sqrt,
                    reserve,
                    fees: 0,
                };
                let mut orders = Vec::new();
                for order in &case.orders {
                    let mut trial = state.clone();
                    match swap(&compiled, &mut trial, order) {
                        Ok(value) => {
                            if !matches!(case.scenario, Scenario::WhaleSell) {
                                state = trial;
                            }
                            orders.push(json!({"status":"success","order":order,"result":value}));
                        }
                        Err(e) => {
                            orders.push(json!({"status":"rejected","order":order,"reason":e}))
                        }
                    }
                }
                Ok(
                    json!({"orders":orders,"final_sqrt_price":Atomic(state.sqrt),"final_quote_reserve":Atomic(state.reserve),"fees":Atomic(state.fees),"historical_parity":false,"wallet_balance_enforcement":false}),
                )
            }
            Scenario::RoyaltyFork => {
                let amount = raw(&case.inputs, "claimable_fees")?;
                let amount = u64::try_from(amount).map_err(|_| "Claimable fees exceed u64")?;
                Ok(
                    json!({"allocation":compiled.economy.fee_policy.allocate(amount)?.map(|x| Atomic(x.into())),"basis":"actually_claimed_fees_excluding_principal","on_chain_enforcement":false}),
                )
            }
            Scenario::Redemption => {
                let reserve = raw(&case.inputs, "reserve")?;
                let supply = raw(&case.inputs, "outstanding_supply")?;
                let burn = raw(&case.inputs, "burn")?;
                if supply == 0 || burn > supply {
                    return Err("Invalid burn or outstanding supply".into());
                }
                let payout =
                    to_u128(BigUint::from(burn) * BigUint::from(reserve) / BigUint::from(supply))?;
                Ok(
                    json!({"payout":Atomic(payout),"remaining_reserve":Atomic(reserve-payout),"remaining_supply":Atomic(supply-burn),"contract_enforced":false}),
                )
            }
            Scenario::Funding => {
                let reserve = raw(&case.inputs, "escrow_reserve")?;
                let release = raw(&case.inputs, "requested_release")?;
                let approved = case
                    .inputs
                    .get("approved")
                    .and_then(Value::as_bool)
                    .ok_or("Approval state is required")?;
                let replay = case
                    .inputs
                    .get("already_released")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if replay || !approved || release > reserve {
                    return Err("Release rejected: approval, replay or balance constraint".into());
                }
                Ok(
                    json!({"released":Atomic(release),"remaining":Atomic(reserve-release),"contract_enforced":false}),
                )
            }
            Scenario::AssetQuote => {
                let quote = raw(&case.inputs, "quote_amount")?;
                let price = raw(&case.inputs, "usd_price_micro")?;
                let usd = to_u128(
                    BigUint::from(quote) * BigUint::from(price)
                        / BigUint::from(10u128.pow(case.economy.quote_decimals.into())),
                )?;
                Ok(
                    json!({"quote_amount":Atomic(quote),"usd_value_micro":Atomic(usd),"price_source":case.inputs.get("price_source"),"reserve_unchanged":true}),
                )
            }
            Scenario::Compounding => {
                let fees = raw(&case.inputs, "non_protocol_fees")?;
                let compound = to_u128(
                    BigUint::from(fees) * BigUint::from(case.economy.compounding_fee_bps)
                        / BigUint::from(10_000u32),
                )?;
                Ok(
                    json!({"compounded":Atomic(compound),"claimable":Atomic(fees-compound),"reserve_after":Atomic(compiled.pool_quote.0.checked_add(compound).ok_or("Reserve overflow")?),"assumption":"Fee accounting only; no claim of native pool reinvestment execution"}),
                )
            }
            Scenario::AdditionalCapital => {
                let base = raw(&case.inputs, "base_reserve")?;
                let quote = raw(&case.inputs, "quote_reserve")?;
                let deposit = raw(&case.inputs, "quote_deposit")?;
                if quote == 0 {
                    return Err("Quote reserve must be positive".into());
                }
                let base_deposit = to_u128(div_up(
                    BigUint::from(base) * BigUint::from(deposit),
                    BigUint::from(quote),
                ))?;
                Ok(
                    json!({"required_base_deposit":Atomic(base_deposit),"new_base_reserve":Atomic(base.checked_add(base_deposit).ok_or("Reserve overflow")?),"new_quote_reserve":Atomic(quote.checked_add(deposit).ok_or("Reserve overflow")?),"balanced_deposit":true}),
                )
            }
            Scenario::VestingLock => {
                let total = raw(&case.inputs, "total")?;
                let cliff = raw(&case.inputs, "cliff")?;
                let start = raw(&case.inputs, "start")?;
                let duration = raw(&case.inputs, "duration")?;
                let permanent = case
                    .inputs
                    .get("permanent")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if cliff > total || duration == 0 {
                    return Err("Invalid vesting schedule".into());
                }
                let elapsed = u128::from(clock).saturating_sub(start).min(duration);
                let unlocked = if permanent || u128::from(clock) < start {
                    0
                } else {
                    cliff
                        + to_u128(
                            BigUint::from(total - cliff) * BigUint::from(elapsed)
                                / BigUint::from(duration),
                        )?
                };
                Ok(
                    json!({"unlockable":Atomic(unlocked),"locked":Atomic(total-unlocked),"contract_enforced":false}),
                )
            }
            Scenario::FeeSchedule => {
                let start = raw(&case.inputs, "start")?;
                let period = raw(&case.inputs, "period_seconds")?;
                let initial = raw(&case.inputs, "initial_bps")?;
                let minimum = raw(&case.inputs, "minimum_bps")?;
                let reduction = raw(&case.inputs, "reduction_bps")?;
                if period == 0 || initial > 9900 || minimum > initial {
                    return Err("Invalid analytical fee schedule".into());
                }
                let timestamps = case.inputs["timestamps"]
                    .as_array()
                    .ok_or("Timestamps required")?;
                if timestamps.len() > 1000 {
                    return Err("At most 1000 scheduler observations are allowed".into());
                }
                let mut points = vec![];
                for value in timestamps {
                    let timestamp = serde_json::from_value::<Atomic>(value.clone())
                        .map_err(|e| e.to_string())?
                        .0;
                    let periods = timestamp.saturating_sub(start) / period;
                    let decrement = periods
                        .checked_mul(reduction)
                        .ok_or("Fee schedule overflow")?;
                    points.push(json!({"timestamp":Atomic(timestamp),"fee_bps":initial.saturating_sub(decrement).max(minimum)}));
                }
                Ok(
                    json!({"points":points,"scheduler":"analytical_linear_decay","native_scheduler_equivalence":false}),
                )
            }
        }
    };
    match run() {
        Ok(result) => {
            json!({"status":"completed","evidence":"analytical","engine_version":ENGINE_VERSION,"model_hash":compiled.content_hash,"seed":seed,"clock":clock,"scenario":case.scenario,"assumptions":["Integer segment integration; floor quote output, ceiling input","Fixed fee; protocol split not included in trading fees","Migration protocol fee assumed 20 bps of retained quote","No gas, rent, transfer fees or wallet inventory included"],"result":result})
        }
        Err(e) => {
            json!({"status":"rejected","evidence":"analytical","engine_version":ENGINE_VERSION,"model_hash":compiled.content_hash,"scenario":case.scenario,"reason":e})
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GridAxis {
    pub path: String,
    pub values: Vec<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GridRequest {
    pub base: Case,
    pub axes: Vec<GridAxis>,
    pub seed: String,
    pub clock: u64,
    #[serde(default)]
    pub frozen_paths: Vec<String>,
}
impl GridRequest {
    pub fn expand(self) -> Result<ResearchRequest, String> {
        if self.axes.is_empty() || self.axes.len() > 3 {
            return Err("A sensitivity grid requires one to three axes".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut models = vec![serde_json::to_value(&self.base.economy).map_err(|e| e.to_string())?];
        for axis in self.axes {
            if !axis.path.starts_with('/')
                || !seen.insert(axis.path.clone())
                || axis.values.is_empty()
                || axis.values.len() > 100
            {
                return Err("Axes require unique JSON pointers and one to 100 values".into());
            }
            if models
                .len()
                .checked_mul(axis.values.len())
                .is_none_or(|n| n > 1000)
            {
                return Err("Grid exceeds 1000 cases".into());
            }
            let mut expanded = vec![];
            for model in models {
                for value in &axis.values {
                    let mut next = model.clone();
                    *next
                        .pointer_mut(&axis.path)
                        .ok_or("Grid parameter does not exist")? = value.clone();
                    expanded.push(next);
                }
            }
            models = expanded;
        }
        let mut cases = vec![];
        for model in models {
            let mut case = self.base.clone();
            case.economy = serde_json::from_value(model).map_err(|e| e.to_string())?;
            cases.push(case);
        }
        let request = ResearchRequest {
            evidence: "analytical".into(),
            seed: self.seed,
            clock: self.clock,
            cases,
            frozen_paths: self.frozen_paths,
        };
        request.validate()?;
        Ok(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn economy() -> Economy {
        serde_json::from_value(json!({"schema_version":1,"mechanism":"meme","base_decimals":6,"quote_decimals":9,"supply":"1000000000000000","sqrt_start_price":"1844674407370955","curve":[{"sqrt_price":"18446744073709551","liquidity":"1000000000000000000000000000000"}],"migration_quote_threshold":"10000000","trade_fee_bps":25,"migration_fee_pct":0,"compounding_fee_bps":0,"fee_policy":{"author":"11111111111111111111111111111111","launcher_bps":8000,"author_bps":1000,"platform_bps":1000}})).unwrap()
    }
    #[test]
    fn burn_all_conserves_reserve_and_rejects_overburn() {
        let mut c = Case {
            scenario: Scenario::Redemption,
            economy: economy(),
            orders: vec![],
            inputs: json!({"reserve":"103","outstanding_supply":"10","burn":"10"}),
        };
        let result = run_case(&c, "1", 0);
        assert_eq!(result["result"]["payout"], "103");
        c.inputs["burn"] = json!("11");
        assert_eq!(run_case(&c, "1", 0)["status"], "rejected");
    }
    #[test]
    fn deterministic_runs_and_rejected_cases_are_preserved() {
        let c = Case {
            scenario: Scenario::SequentialTrading,
            economy: economy(),
            orders: vec![
                Order {
                    direction: Direction::Buy,
                    amount: Atomic(10000),
                    exact_out: false,
                },
                Order {
                    direction: Direction::Sell,
                    amount: Atomic(u64::MAX.into()),
                    exact_out: false,
                },
            ],
            inputs: json!({}),
        };
        let a = run_case(&c, "fixed", 42);
        assert_eq!(a, run_case(&c, "fixed", 42));
        assert_eq!(a["result"]["orders"][0]["status"], "success");
        assert_eq!(a["result"]["orders"][1]["status"], "rejected");
    }
    #[test]
    fn exact_output_near_graduation_finds_bracket_after_overshoot() {
        let compiled = economy().compile().unwrap();
        let mut state = CurveState {
            sqrt: compiled.economy.sqrt_start_price.0,
            reserve: 0,
            fees: 0,
        };
        let mut target_state = state.clone();
        let result = exact_in(&compiled, &mut target_state, Direction::Buy, 9_000_000).unwrap();
        let target: u128 = result["output"].as_str().unwrap().parse().unwrap();
        let order = Order {
            direction: Direction::Buy,
            amount: Atomic(target),
            exact_out: true,
        };
        let result = swap(&compiled, &mut state, &order).unwrap();
        assert_eq!(result["requested_output"], target.to_string());
        assert!(result["input"].as_str().unwrap().parse::<u128>().unwrap() <= 9_000_000);
    }
    #[test]
    fn sensitivity_grid_preserves_constraints_and_invalid_combinations() {
        let base = Case {
            scenario: Scenario::Graduation,
            economy: economy(),
            orders: vec![],
            inputs: Value::Null,
        };
        let grid = GridRequest {
            base,
            axes: vec![GridAxis {
                path: "/trade_fee_bps".into(),
                values: vec![json!(25), json!(0)],
            }],
            seed: "fixed".into(),
            clock: 1,
            frozen_paths: vec!["/supply".into()],
        };
        let request = grid.expand().unwrap();
        assert_eq!(request.cases.len(), 2);
        assert_eq!(run_case(&request.cases[1], "fixed", 1)["status"], "invalid");
        let mut invalid = GridRequest {
            base: request.cases[0].clone(),
            axes: vec![GridAxis {
                path: "/supply".into(),
                values: vec![json!("1"), json!("2")],
            }],
            seed: "fixed".into(),
            clock: 1,
            frozen_paths: vec!["/supply".into()],
        };
        assert!(invalid.clone().expand().is_err());
        invalid.axes[0].path = "/missing".into();
        assert!(invalid.expand().is_err());
    }
    #[test]
    fn frozen_constraints_cannot_drift() {
        let a = Case {
            scenario: Scenario::Graduation,
            economy: economy(),
            orders: vec![],
            inputs: Value::Null,
        };
        let mut b = a.clone();
        b.economy.supply = Atomic(2);
        let r = ResearchRequest {
            evidence: "analytical".into(),
            seed: "1".into(),
            clock: 0,
            cases: vec![a, b],
            frozen_paths: vec!["/supply".into()],
        };
        assert!(r.validate().is_err());
    }
}
