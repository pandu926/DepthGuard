use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas, prelude::Pubkey};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use depthguard_escrow as escrow;
use depthguard_registry as registry;
use depthguard_reserve as reserve;
use serde_json::{Value, json};
use std::str::FromStr;
fn key(v: &Value, k: &str) -> Result<Pubkey> {
    Pubkey::from_str(v[k].as_str().context("Missing contract account")?)
        .context("Invalid public key")
}
fn n(v: &Value, k: &str) -> Result<u64> {
    let s = v[k]
        .as_str()
        .context("Atomic value must be a decimal string")?;
    ensure!(s.len() <= 20, "Atomic amount exceeds width");
    ensure!(
        !s.is_empty() && (s == "0" || !s.starts_with('0')) && s.bytes().all(|b| b.is_ascii_digit()),
        "Invalid atomic amount"
    );
    Ok(s.parse()?)
}
fn digest(v: &Value, k: &str) -> Result<[u8; 32]> {
    let bytes = STANDARD.decode(v[k].as_str().context("Missing digest")?)?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("Digest must be 32 bytes"))
}
fn keys(v: &Value, k: &str) -> Result<Vec<Pubkey>> {
    v[k].as_array()
        .context("Public key list required")?
        .iter()
        .map(|x| Pubkey::from_str(x.as_str().context("Public key required")?).map_err(Into::into))
        .collect()
}
fn milestones(v: &Value) -> Result<Vec<economy_core::Milestone>> {
    v.as_array()
        .context("Milestones required")?
        .iter()
        .map(|x| {
            Ok(economy_core::Milestone {
                weight_bps: u16::try_from(x["weight_bps"].as_u64().context("Weight required")?)?,
                deadline_offset: i64::try_from(n(x, "deadline_offset")?)?,
            })
        })
        .collect()
}
pub fn model(v: &Value) -> Result<Value> {
    if let Some(economy) = v.get("economy") {
        let e: depthguard_domain::economy::Economy = serde_json::from_value(economy.clone())?;
        ensure!(
            key(v, "author")?.to_string() == e.fee_policy.author,
            "Author differs from economy policy"
        );
        let compiled = e.compile().map_err(|x| anyhow::anyhow!(x.join("; ")))?;
        let mechanism = match e.mechanism {
            depthguard_domain::economy::Mechanism::Meme => 0,
            depthguard_domain::economy::Mechanism::Funding => 1,
            depthguard_domain::economy::Mechanism::Backed => 2,
            depthguard_domain::economy::Mechanism::AssetQuote => 3,
        };
        let milestones = e
            .module
            .as_ref()
            .map(|m| {
                m.milestones
                    .iter()
                    .map(|s| json!({"weight_bps":s.weight_bps,"deadline_offset":s.deadline_offset}))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let input = json!({"publisher":v["publisher"],"parent":v["parent"],"author":v["author"],"parameters":e.contract_native_parameters().map_err(anyhow::Error::msg)?,"mechanism":mechanism,"quote_decimals":e.quote_decimals,"launcher_bps":e.fee_policy.launcher_bps,"author_bps":e.fee_policy.author_bps,"platform_bps":e.fee_policy.platform_bps,"reviewer_threshold":e.module.as_ref().map(|m|m.reviewer_threshold).unwrap_or(0),"milestones":milestones});
        let mut result = model(&input)?;
        result["json_hash"] = json!(STANDARD.encode(hex_decode(&compiled.content_hash)?));
        result["canonical_json_hash"] = json!(compiled.content_hash);
        return Ok(result);
    }

    let config = depthguard_domain::native::encode("dbc", "ConfigParameters", &v["parameters"])
        .map_err(anyhow::Error::msg)?;
    let spec = economy_core::ModelSpec {
        schema_version: 2,
        mechanism: u8::try_from(v["mechanism"].as_u64().context("Mechanism required")?)?,
        quote_decimals: u8::try_from(
            v["quote_decimals"]
                .as_u64()
                .context("Quote decimals required")?,
        )?,
        launcher_bps: u16::try_from(
            v["launcher_bps"]
                .as_u64()
                .context("Launcher share required")?,
        )?,
        author_bps: u16::try_from(v["author_bps"].as_u64().context("Author share required")?)?,
        platform_bps: u16::try_from(
            v["platform_bps"]
                .as_u64()
                .context("Platform share required")?,
        )?,
        reviewer_threshold: u8::try_from(
            v["reviewer_threshold"]
                .as_u64()
                .context("Threshold required")?,
        )?,
        milestones: milestones(&v["milestones"])?,
        native_config: config,
    };
    spec.validate()?;
    registry::validate_profile(&spec)?;
    use anchor_lang::AnchorSerialize;
    let mut bytes = Vec::new();
    spec.serialize(&mut bytes)?;
    let hash = economy_core::executable_digest(
        key(v, "publisher")?,
        key(v, "parent")?,
        key(v, "author")?,
        &bytes,
    );
    Ok(
        json!({"bytes":STANDARD.encode(&bytes),"digest":STANDARD.encode(hash),"size":bytes.len(),"schema_version":2}),
    )
}
pub fn build(v: &Value) -> Result<Value> {
    let a = &v["accounts"];
    let p = &v["args"];
    let action = v["action"].as_str().context("Contract action required")?;
    if ["wrap_sol", "unwrap_sol"].contains(&action) {
        return crate::factory::wrap(v);
    }
    if action == "create_fee_vault" {
        ensure!(
            key(a, "quote_mint")?
                == Pubkey::from_str("So11111111111111111111111111111111111111112")?,
            "Contract fee vaults require WSOL"
        );
        return crate::fees::create(&json!({"base":a["fee_base"],"wallet":a["launcher"],
            "quote_mint":a["quote_mint"],"recipients":p["recipients"]}));
    }

    macro_rules! accounts{($ty:ident,$module:ident,{$($field:ident),*})=>{$module::accounts::$ty{$($field:key(a,stringify!($field))?),*}.to_account_metas(None)}}
    let (id, metas, data) = match action {
        "begin_model" => (
            registry::ID,
            registry::accounts::BeginModel {
                platform: key(a, "platform")?,
                model: key(a, "model")?,
                parent: if a["parent"].is_null() {
                    None
                } else {
                    Some(key(a, "parent")?)
                },
                publisher: key(a, "publisher")?,
                system_program: Pubkey::default(),
            }
            .to_account_metas(None),
            registry::instruction::BeginModel {
                digest: digest(p, "digest")?,
                json_hash: digest(p, "json_hash")?,
                size: u32::try_from(n(p, "size")?)?,
            }
            .data(),
        ),
        "write_model" => (
            registry::ID,
            accounts!(WriteModel,registry,{model,publisher}),
            registry::instruction::WriteModel {
                offset: u32::try_from(n(p, "offset")?)?,
                bytes: STANDARD.decode(p["bytes"].as_str().context("Bytes required")?)?,
            }
            .data(),
        ),
        "seal_model" => (
            registry::ID,
            accounts!(WriteModel,registry,{model,publisher}),
            registry::instruction::SealModel {}.data(),
        ),
        "initialize_launch" => (
            registry::ID,
            accounts!(InitializeLaunch,registry,{platform,model,launch,launcher,system_program}),
            registry::instruction::InitializeLaunch {
                nonce: n(p, "nonce")?,
                config: key(p, "config")?,
                base_mint: key(p, "base_mint")?,
                fee_vault: key(p, "fee_vault")?,
                first_position_mint: key(p, "first_position_mint")?,
                reviewers: keys(p, "reviewers")?,
            }
            .data(),
        ),
        "create_config" => (
            registry::ID,
            accounts!(CreateConfig,registry,{platform,model,launch,config,fee_vault,quote_mint,launcher,dbc_program,event_authority,system_program}),
            registry::instruction::CreateConfig {}.data(),
        ),
        "create_pool" => (
            registry::ID,
            accounts!(CreatePool,registry,{launch,config,pool_authority,base_mint,quote_mint,pool,base_vault,quote_vault,mint_metadata,metadata_program,launcher,token_program,dbc_program,system_program,event_authority}),
            registry::instruction::CreatePool {
                name: p["name"].as_str().context("Name required")?.into(),
                symbol: p["symbol"].as_str().context("Symbol required")?.into(),
                uri: p["uri"].as_str().context("URI required")?.into(),
            }
            .data(),
        ),
        "initialize_module" => (
            registry::ID,
            accounts!(InitializeModule,registry,{launch,model,base_mint,quote_mint,module_vault,token_vault,module_program,launcher,token_program,associated_token_program,system_program}),
            registry::instruction::InitializeModule {}.data(),
        ),
        "verify_migration" => (
            registry::ID,
            accounts!(VerifyMigration,registry,{launch,base_mint,config,pool,damm_pool,position,position_nft}),
            registry::instruction::VerifyMigration {}.data(),
        ),
        "fund_and_activate" => (
            registry::ID,
            accounts!(FundAndActivate,registry,{launch,config,pool,module_vault,token_vault,module_program,quote_mint,quote_vault,pool_authority,token_program,dbc_program,event_authority}),
            registry::instruction::FundAndActivate {}.data(),
        ),
        "escrow_vote" => (
            escrow::ID,
            accounts!(Vote,escrow,{vault,reviewer,token_vault,beneficiary_tokens,token_program}),
            escrow::instruction::Vote {
                approve: p["approve"].as_bool().context("Approval required")?,
            }
            .data(),
        ),
        "escrow_fail_expired" => (
            escrow::ID,
            accounts!(Fail, escrow, { vault }),
            escrow::instruction::FailExpired {}.data(),
        ),
        "reserve_deposit" => (
            reserve::ID,
            accounts!(Deposit,reserve,{vault,base_mint,depositor,source,token_vault,token_program}),
            reserve::instruction::Deposit {
                amount: n(p, "amount")?,
            }
            .data(),
        ),
        "reserve_redeem" => (
            reserve::ID,
            accounts!(Redeem,reserve,{vault,base_mint,holder,holder_tokens,token_vault,receiver,token_program}),
            reserve::instruction::Redeem {
                burn_amount: n(p, "burn_amount")?,
                min_payout: n(p, "min_payout")?,
            }
            .data(),
        ),
        "escrow_refund" => (
            escrow::ID,
            accounts!(Redeem,escrow,{vault,base_mint,holder,holder_tokens,token_vault,receiver,token_program}),
            escrow::instruction::Redeem {
                burn_amount: n(p, "burn_amount")?,
                min_payout: n(p, "min_payout")?,
            }
            .data(),
        ),
        _ => bail!("Unsupported contract action"),
    };
    let mut result = json!({"program_id":id.to_string(),"accounts":metas.iter().map(|a|json!({"address":a.pubkey.to_string(),"signer":a.is_signer,"writable":a.is_writable})).collect::<Vec<_>>(),"data":STANDARD.encode(data)});
    if ["reserve_redeem", "escrow_refund", "escrow_vote"].contains(&action)
        && !a["quote_mint"].is_null()
    {
        let wallet = key(
            a,
            if action == "escrow_vote" {
                "reviewer"
            } else {
                "holder"
            },
        )?;
        let owner = if action == "escrow_vote" {
            key(a, "beneficiary")?
        } else {
            wallet
        };
        let mint = key(a, "quote_mint")?;
        let token = anchor_spl_id();
        let ata_program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?;
        let receiver = Pubkey::find_program_address(
            &[owner.as_ref(), token.as_ref(), mint.as_ref()],
            &ata_program,
        )
        .0;
        ensure!(
            receiver
                == key(
                    a,
                    if action == "escrow_vote" {
                        "beneficiary_tokens"
                    } else {
                        "receiver"
                    }
                )?,
            "Receiver must be the holder ATA when creating it"
        );
        let ata = json!({"program_id":ata_program.to_string(),"accounts":[{"address":wallet.to_string(),"signer":true,"writable":true},{"address":receiver.to_string(),"signer":false,"writable":true},{"address":owner.to_string(),"signer":false,"writable":false},{"address":mint.to_string(),"signer":false,"writable":false},{"address":Pubkey::default().to_string(),"signer":false,"writable":false},{"address":token.to_string(),"signer":false,"writable":false}],"data":STANDARD.encode([1u8])});
        result["instructions"] = json!([ata, result.clone()]);
    }
    Ok(result)
}
pub fn state(v: &Value) -> Result<Value> {
    let data = STANDARD.decode(v["data"].as_str().context("Account data required")?)?;
    ensure!(data.len() <= 16384, "Account exceeds limit");
    let kind = v["kind"].as_str().context("Kind required")?;
    let mut bytes = data.as_slice();
    match kind {
        "model" => {
            let m = registry::ModelVersion::try_deserialize(&mut bytes)?;
            Ok(
                json!({"publisher":m.publisher.to_string(),"author":m.author.to_string(),"parent":m.parent.to_string(),"sealed":m.sealed,"digest":STANDARD.encode(m.digest),"json_hash":STANDARD.encode(m.json_hash),"uploaded_bytes":m.data.len(),"size":m.size}),
            )
        }
        "launch" => {
            let l = registry::LaunchInstance::try_deserialize(&mut bytes)?;
            Ok(
                json!({"model":l.model.to_string(),"launcher":l.launcher.to_string(),"phase":l.phase,"mechanism":l.mechanism,"nonce":l.nonce.to_string(),"config":l.config.to_string(),"base_mint":l.base_mint.to_string(),"quote_mint":l.quote_mint.to_string(),"fee_vault":l.fee_vault.to_string(),"damm_pool":l.damm_pool.to_string(),"module_initialized":l.module_initialized,"first_position_mint":l.first_position_mint.to_string(),"damm_config":l.damm_config.to_string()}),
            )
        }
        "escrow" | "reserve" => {
            let s = if kind == "escrow" {
                escrow::Vault::try_deserialize(&mut bytes)?.state
            } else {
                reserve::Vault::try_deserialize(&mut bytes)?.state
            };
            Ok(
                json!({"launch":s.launch.to_string(),"base_mint":s.base_mint.to_string(),"quote_mint":s.quote_mint.to_string(),"beneficiary":s.beneficiary.to_string(),"state":s.state,"activated_at":s.activated_at,"initial_funding":s.initial_funding.to_string(),"current_milestone":s.current,"approve_mask":s.approve_mask,"reject_mask":s.reject_mask,"threshold":s.threshold,"reviewers":s.reviewers.iter().map(ToString::to_string).collect::<Vec<_>>(),"budgets":s.budgets.iter().map(ToString::to_string).collect::<Vec<_>>(),"milestones":s.milestones.iter().map(|m|json!({"weight_bps":m.weight_bps,"deadline_offset":m.deadline_offset.to_string()})).collect::<Vec<_>>()}),
            )
        }
        _ => bail!("Unsupported contract account kind"),
    }
}
pub fn quote_accounts(v: &Value) -> Result<Value> {
    let vault = key(v, "vault")?;
    let quote = key(v, "quote_mint")?;
    let ata = Pubkey::find_program_address(
        &[vault.as_ref(), anchor_spl_id().as_ref(), quote.as_ref()],
        &Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")?,
    )
    .0;
    Ok(json!({"token_vault":ata.to_string()}))
}
fn anchor_spl_id() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}
pub fn redemption_quote(v: &Value) -> Result<Value> {
    let kind = v["kind"].as_str().context("Kind required")?;
    let accounts = v["accounts"].as_array().context("Snapshot required")?;
    ensure!(accounts.len() == 3, "Incomplete snapshot");
    let owner = if kind == "reserve" {
        reserve::ID
    } else if kind == "escrow" {
        escrow::ID
    } else {
        bail!("Unsupported module")
    };
    ensure!(
        accounts[0]["owner"] == owner.to_string()
            && accounts[1]["owner"] == anchor_spl_id().to_string()
            && accounts[2]["owner"] == anchor_spl_id().to_string(),
        "Snapshot owner mismatch"
    );
    let s = state(&json!({"kind":kind,"data":accounts[0]["data"][0]}))?;
    ensure!(
        if kind == "reserve" {
            s["state"] == economy_core::ACTIVE
        } else {
            s["state"] == economy_core::REFUNDING || s["state"] == economy_core::COMPLETED
        },
        "Redemption inactive"
    );
    let mint = STANDARD.decode(
        accounts[1]["data"][0]
            .as_str()
            .context("Mint data required")?,
    )?;
    let token = STANDARD.decode(
        accounts[2]["data"][0]
            .as_str()
            .context("Token data required")?,
    )?;
    ensure!(
        mint.len() == 82
            && mint[..4] == [0; 4]
            && mint[46..50] == [0; 4]
            && mint[45] == 1
            && token.len() == 165
            && token[..32] == key(&s, "quote_mint")?.to_bytes()
            && token[32..64] == key(v, "vault")?.to_bytes()
            && token[108] == 1,
        "Invalid reserve token snapshot"
    );
    let supply = u64::from_le_bytes(mint[36..44].try_into()?);
    let reserve = u64::from_le_bytes(token[64..72].try_into()?);
    let burn = n(v, "burn_amount")?;
    let amount = economy_core::payout(burn, reserve, supply, 1)
        .map_err(|_| anyhow::anyhow!("Payout unavailable"))?;
    Ok(
        json!({"burn_amount":burn.to_string(),"payout":amount.to_string(),"reserve":reserve.to_string(),"outstanding_supply":supply.to_string(),"quote_mint":s["quote_mint"],"basis":"all_unburned_mint_supply","exit_fee_bps":0}),
    )
}

fn hex_decode(s: &str) -> Result<Vec<u8>> {
    ensure!(s.len() == 64, "Invalid hash");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(Into::into))
        .collect()
}
pub fn event(v: &Value) -> Result<Value> {
    use anchor_lang::{AnchorDeserialize, Discriminator};
    let bytes = STANDARD.decode(v["data"].as_str().context("Event required")?)?;
    ensure!(
        bytes.len() >= 8 && bytes.len() <= 4096,
        "Invalid event size"
    );
    let d = &bytes[..8];
    let body = &bytes[8..];
    let program = key(v, "program_id")?;
    if program == registry::ID {
        if d == registry::ModelPublished::DISCRIMINATOR {
            let e = registry::ModelPublished::try_from_slice(body)?;
            return Ok(
                json!({"kind":"model_published","version":e.version,"model":e.model.to_string(),"publisher":e.publisher.to_string(),"author":e.author.to_string(),"parent":e.parent.to_string(),"digest":STANDARD.encode(e.digest),"json_hash":STANDARD.encode(e.json_hash)}),
            );
        }
        if d == registry::LaunchTransition::DISCRIMINATOR {
            let e = registry::LaunchTransition::try_from_slice(body)?;
            return Ok(
                json!({"kind":"launch_transition","version":e.version,"launch":e.launch.to_string(),"model":e.model.to_string(),"previous":e.previous,"next":e.next,"amount":e.amount.to_string()}),
            );
        }
    } else if program == reserve::ID || program == escrow::ID {
        if d == reserve::ModuleTransition::DISCRIMINATOR {
            let e = reserve::ModuleTransition::try_from_slice(body)?;
            return Ok(
                json!({"kind":"module_transition","version":e.version,"launch":e.launch.to_string(),"previous":e.previous,"next":e.next,"amount":e.amount.to_string()}),
            );
        }
        if d == reserve::Redeemed::DISCRIMINATOR {
            let e = reserve::Redeemed::try_from_slice(body)?;
            return Ok(
                json!({"kind":"redeemed","version":e.version,"launch":e.launch.to_string(),"holder":e.holder.to_string(),"burned":e.burned.to_string(),"paid":e.paid.to_string(),"supply_before":e.supply_before.to_string(),"reserve_before":e.reserve_before.to_string()}),
            );
        }
        if program == reserve::ID && d == reserve::ReserveDeposit::DISCRIMINATOR {
            let e = reserve::ReserveDeposit::try_from_slice(body)?;
            return Ok(
                json!({"kind":"reserve_deposit","version":e.version,"launch":e.launch.to_string(),"depositor":e.depositor.to_string(),"amount":e.amount.to_string()}),
            );
        }
    }
    Ok(json!({"kind":"untracked"}))
}
