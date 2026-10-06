use anchor_lang::{AccountDeserialize, prelude::Pubkey};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use depthguard_registry as registry;
use serde_json::{Value, json};
use std::str::FromStr;
fn key(v: &Value, k: &str) -> Result<Pubkey> {
    Ok(Pubkey::from_str(
        v[k].as_str().context("Missing factory key")?,
    )?)
}
fn pda(id: Pubkey, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &id).0
}
pub fn platform(v: &Value) -> Result<Value> {
    let address = pda(registry::ID, &[b"platform"]);
    if v["data"].is_null() {
        return Ok(json!({"address":address.to_string()}));
    }
    let bytes = STANDARD.decode(v["data"].as_str().context("Platform data required")?)?;
    let s = registry::Platform::try_deserialize(&mut bytes.as_slice())?;
    Ok(
        json!({"address":address.to_string(),"recipient":s.recipient.to_string(),"damm_config":s.damm_config.to_string(),"paused":s.paused}),
    )
}
pub fn plan(v: &Value) -> Result<Value> {
    let launcher = key(v, "wallet")?;
    let base = key(v, "base_mint")?;
    let config = key(v, "config")?;
    let quote = Pubkey::from_str("So11111111111111111111111111111111111111112")?;
    let token = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
    let associated = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?;
    let encoded = crate::contracts::model(v)?;
    let digest = STANDARD.decode(encoded["digest"].as_str().context("Digest missing")?)?;
    let model = pda(
        registry::ID,
        &[b"model", key(v, "publisher")?.as_ref(), &digest],
    );
    let nonce: u64 = v["nonce"].as_str().context("Nonce required")?.parse()?;
    let launch = pda(
        registry::ID,
        &[
            b"launch",
            model.as_ref(),
            launcher.as_ref(),
            &nonce.to_le_bytes(),
        ],
    );
    let platform = pda(registry::ID, &[b"platform"]);
    let pool_ix = crate::launch::pool(v)?;
    let pool = key(&pool_ix, "pool")?;
    let mechanism = v["economy"]["mechanism"]
        .as_str()
        .context("Mechanism required")?;
    let module = if mechanism == "funding" {
        depthguard_escrow::ID
    } else {
        depthguard_reserve::ID
    };
    let vault = pda(module, &[b"vault", launch.as_ref()]);
    let token_vault = pda(
        associated,
        &[vault.as_ref(), token.as_ref(), quote.as_ref()],
    );
    let fee = crate::fees::create(
        &json!({"base":v["fee_base"],"wallet":launcher.to_string(),"quote_mint":quote.to_string(),"recipients":v["recipients"]}),
    )?;
    let mut a = json!({"platform":platform.to_string(),"model":model.to_string(),"publisher":v["publisher"],"launch":launch.to_string(),"launcher":launcher.to_string(),"config":config.to_string(),"base_mint":base.to_string(),"quote_mint":quote.to_string(),"fee_vault":fee["vault"],"pool":pool.to_string(),"pool_authority":dynamic_bonding_curve::const_pda::pool_authority::ID.to_string(),"base_vault":pool_ix["base_vault"],"quote_vault":pool_ix["quote_vault"],"mint_metadata":pool_ix["accounts"][8]["address"],"metadata_program":"metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s","token_program":token.to_string(),"dbc_program":dynamic_bonding_curve::ID.to_string(),"system_program":Pubkey::default().to_string(),"event_authority":pda(dynamic_bonding_curve::ID,&[b"__event_authority"]).to_string(),"module_vault":vault.to_string(),"token_vault":token_vault.to_string(),"module_program":module.to_string(),"associated_token_program":associated.to_string()});
    if v["parent"] != Pubkey::default().to_string() {
        a["parent"] = v["parent"].clone();
    }
    let build = |action: &str, args: Value| -> Result<Value> {
        crate::contracts::build(&json!({"action":action,"accounts":a,"args":args}))
    };
    let mut steps = Vec::new();
    steps.push(json!({"step":"begin_model","instruction":build("begin_model",json!({"digest":encoded["digest"],"json_hash":encoded["json_hash"],"size":encoded["size"].to_string()}))?,"projections":[{"address":model.to_string(),"kind":"model"}]}));
    let bytes = STANDARD.decode(encoded["bytes"].as_str().context("Bytes missing")?)?;
    for (index, chunk) in bytes.chunks(600).enumerate() {
        steps.push(json!({"step":format!("write_model_{index}"),"instruction":build("write_model",json!({"offset":(index*600).to_string(),"bytes":STANDARD.encode(chunk)}))?,"projections":[{"address":model.to_string(),"kind":"model"}]}));
    }
    steps.push(json!({"step":"seal_model","instruction":build("seal_model",json!({}))?,"projections":[{"address":model.to_string(),"kind":"model"}]}));
    steps.push(
        json!({"step":"fee_vault","instruction":fee,"signers":["fee_base"],"projections":[]}),
    );
    steps.push(json!({"step":"initialize_launch","instruction":build("initialize_launch",json!({"nonce":nonce.to_string(),"config":config.to_string(),"base_mint":base.to_string(),"fee_vault":a["fee_vault"],"first_position_mint":v["first_position_mint"],"reviewers":v["reviewers"]}))?,"projections":[{"address":launch.to_string(),"kind":"launch"}]}));
    steps.push(json!({"step":"create_config","instruction":build("create_config",json!({}))?,"signers":["config"],"projections":[{"address":launch.to_string(),"kind":"launch"}]}));
    steps.push(json!({"step":"create_pool","instruction":build("create_pool",json!({"name":v["name"],"symbol":v["symbol"],"uri":v["uri"]}))?,"signers":["mint"],"projections":[{"address":launch.to_string(),"kind":"launch"}]}));
    if mechanism == "funding" || mechanism == "backed" {
        steps.push(json!({"step":"initialize_module","instruction":build("initialize_module",json!({}))?,"projections":[{"address":vault.to_string(),"kind":if mechanism=="funding" {"escrow"} else {"reserve"}},{"address":launch.to_string(),"kind":"launch"}]}));
    }
    Ok(json!({"accounts":a,"encoded":encoded,"steps":steps}))
}

pub fn wrap(v: &Value) -> Result<Value> {
    let wallet = key(&v["accounts"], "launcher")?;
    let token = Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?;
    let mint = Pubkey::from_str("So11111111111111111111111111111111111111112")?;
    let ata_program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?;
    let ata = pda(
        ata_program,
        &[wallet.as_ref(), token.as_ref(), mint.as_ref()],
    );
    let writable = |address: Pubkey, signer: bool| json!({"address":address.to_string(),"signer":signer,"writable":true});
    let readonly =
        |address: Pubkey| json!({"address":address.to_string(),"signer":false,"writable":false});
    let mut instructions = Vec::new();
    if v["action"] == "unwrap_sol" {
        instructions.push(json!({"program_id":token.to_string(),"accounts":[writable(ata,false),writable(wallet,false),json!({"address":wallet.to_string(),"signer":true,"writable":false})],"data":STANDARD.encode([9u8])}));
    } else {
        let amount: u64 = v["args"]["amount"]
            .as_str()
            .context("Amount required")?
            .parse()?;
        anyhow::ensure!(amount > 0, "Positive amount required");
        instructions.push(json!({"program_id":ata_program.to_string(),"accounts":[writable(wallet,true),writable(ata,false),readonly(wallet),readonly(mint),readonly(Pubkey::default()),readonly(token)],"data":STANDARD.encode([1u8])}));
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend(amount.to_le_bytes());
        instructions.push(json!({"program_id":Pubkey::default().to_string(),"accounts":[writable(wallet,true),writable(ata,false)],"data":STANDARD.encode(data)}));
        instructions.push(json!({"program_id":token.to_string(),"accounts":[writable(ata,false)],"data":STANDARD.encode([17u8])}));
    }
    Ok(json!({"program_id":token.to_string(),"instructions":instructions}))
}
pub fn graduation(v: &Value) -> Result<Value> {
    let mut a = v["accounts"].clone();
    let migration = crate::launch::migrate(
        &json!({"config":a["config"],"base_mint":a["base_mint"],"quote_mint":a["quote_mint"],"wallet":a["launcher"],"damm_config":v["damm_config"],"first_position_mint":v["first_position_mint"],"second_position_mint":v["second_position_mint"]}),
    )?;
    a["damm_pool"] = migration["damm_pool"].clone();
    a["position"] = migration["accounts"][7]["address"].clone();
    a["position_nft"] = migration["accounts"][6]["address"].clone();
    let launch = a["launch"].clone();
    let vault = a["module_vault"].clone();
    let kind = if a["module_program"] == depthguard_escrow::ID.to_string() {
        "escrow"
    } else {
        "reserve"
    };
    let mut steps = vec![
        json!({"step":"native_migration","instruction":migration,"signers":["first_position","second_position"],"projections":[]}),
        json!({"step":"verify_migration","instruction":crate::contracts::build(&json!({"action":"verify_migration","accounts":a,"args":{}}))?,"projections":[{"address":launch,"kind":"launch"}]}),
    ];
    if v["capital"] == true {
        steps.push(json!({"step":"fund_and_activate","instruction":crate::contracts::build(&json!({"action":"fund_and_activate","accounts":a,"args":{}}))?,"projections":[{"address":launch,"kind":"launch"},{"address":vault,"kind":kind}]}));
    }
    Ok(json!({"steps":steps}))
}
pub fn publication(v: &Value) -> Result<Value> {
    let encoded = crate::contracts::model(v)?;
    let publisher = key(v, "publisher")?;
    let digest = STANDARD.decode(encoded["digest"].as_str().context("Digest missing")?)?;
    let model = pda(registry::ID, &[b"model", publisher.as_ref(), &digest]);
    let mut a = json!({"publisher":publisher.to_string(),"model":model.to_string(),"platform":pda(registry::ID,&[b"platform"]).to_string()});
    if v["parent"] != Pubkey::default().to_string() {
        a["parent"] = v["parent"].clone();
    }
    let build = |action: &str, args: Value| -> Result<Value> {
        crate::contracts::build(&json!({"action":action,"accounts":a,"args":args}))
    };
    let bytes = STANDARD.decode(encoded["bytes"].as_str().context("Model missing")?)?;
    let mut steps = vec![
        json!({"step":"begin_model","instruction":build("begin_model",json!({"digest":encoded["digest"],"json_hash":encoded["json_hash"],"size":bytes.len().to_string()}))?}),
    ];
    for (i, chunk) in bytes.chunks(600).enumerate() {
        steps.push(json!({"step":format!("write_model_{i}"),"instruction":build("write_model",json!({"offset":(i*600).to_string(),"bytes":STANDARD.encode(chunk)}))?}));
    }
    steps.push(json!({"step":"seal_model","instruction":build("seal_model",json!({}))?}));
    Ok(json!({"accounts":a,"encoded":encoded,"steps":steps}))
}

/// Resolve an existing permanently locked position after permissionless native migration.
pub fn position(v: &Value) -> Result<Value> {
    let mint = key(v, "mint")?;
    let pool = key(v, "pool")?;
    let position = pda(cp_amm::ID, &[b"position", mint.as_ref()]);
    let nft = pda(cp_amm::ID, &[b"position_nft_account", mint.as_ref()]);
    if let Some(encoded) = v["data"].as_str() {
        let data = STANDARD.decode(encoded)?;
        let state = crate::decode::<cp_amm::state::Position>(&data)?;
        anyhow::ensure!(
            state.pool == pool
                && state.nft_mint == mint
                && state.unlocked_liquidity == 0
                && state.vested_liquidity == 0
                && state.permanent_locked_liquidity > 0,
            "Position identity or permanent lock mismatch"
        );
    }
    Ok(json!({"position":position.to_string(),"nft":nft.to_string()}))
}
