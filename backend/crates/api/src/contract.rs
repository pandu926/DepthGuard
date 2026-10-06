use schemars::JsonSchema;
use serde_json::{Value, json};
fn schema<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).expect("Generated schema")
}
pub fn document() -> Value {
    let mut paths = serde_json::Map::new();
    let routes = [
        ("/tokens", "get", "", false),
        ("/tokens/{address}", "get", "", false),
        ("/me/models", "get", "", true),
        ("/me/launches", "get", "", true),
        ("/me/activity", "get", "", true),
        ("/me/portfolio", "get", "", true),
        ("/factory/models/{id}/next", "post", "", true),
        ("/factory/launches", "post", "FactoryInput", true),
        ("/factory/launches/{id}", "get", "", true),
        ("/factory/launches/{id}/next", "post", "", true),
        ("/factory/launches/{id}/graduate", "post", "", true),
        ("/contracts/prepare", "post", "ContractPrepare", true),
        ("/contracts/models/encode", "post", "ContractEncode", true),
        ("/contracts/{kind}/{address}", "get", "", false),
        (
            "/contracts/{kind}/{address}/redemption-quote",
            "post",
            "RedemptionInput",
            false,
        ),
        ("/auth/challenges", "post", "ChallengeInput", false),
        ("/auth/verify", "post", "VerifyInput", false),
        ("/auth/logout", "post", "", true),
        ("/me", "get", "", true),
        ("/me/earnings", "get", "", true),
        ("/markets", "get", "", false),
        ("/markets/{address}", "get", "", false),
        ("/capabilities", "get", "", false),
        ("/parameters", "get", "", false),
        ("/native/validate", "post", "NativeInput", false),
        ("/quotes", "post", "QuoteRequest", false),
        ("/swaps/prepare", "post", "QuoteRequest", true),
        ("/launches", "post", "LaunchInput", true),
        ("/launches/{id}", "get", "", true),
        (
            "/launches/{id}/fees/sweep/prepare",
            "post",
            "SweepInput",
            true,
        ),
        ("/launches/{id}/steps/{step}/prepare", "post", "", true),
        ("/models", "post", "CreateModel", true),
        ("/models/{id}", "get", "", true),
        ("/models/{id}", "patch", "UpdateModel", true),
        ("/models/{id}/publish", "post", "", true),
        ("/model-versions", "get", "", false),
        ("/model-versions/{id}", "get", "", false),
        ("/model-versions/{id}/fork", "post", "ForkInput", true),
        ("/economies/validate", "post", "Economy", false),
        ("/economies/compile", "post", "Economy", false),
        ("/economies/native-parameters", "post", "Economy", false),
        ("/previews", "post", "Case", false),
        ("/simulations", "post", "ResearchRequest", true),
        ("/simulations/grids", "post", "GridRequest", true),
        ("/simulations/{id}", "get", "", true),
        ("/simulations/{id}/cancel", "post", "", true),
        ("/simulations/{id}/export", "get", "", true),
        ("/simulations/{id}/events", "get", "", true),
        ("/datasets", "post", "DatasetInput", true),
        ("/datasets/{id}", "get", "", true),
        ("/fee-vaults/{address}", "get", "", false),
        ("/fee-vaults/{address}/claims/prepare", "post", "", true),
        ("/transactions/{id}", "get", "", true),
        ("/transactions/{id}/submit", "post", "SubmitInput", true),
    ];
    for (path, method, input, auth) in routes {
        let mut operation = json!({"operationId":format!("{}_{}",method,path.trim_matches('/').replace(['/', '{', '}','-'],"_")),"responses":{"200":{"description":"Successful response","content":{"application/json":{"schema":{"type":"object","additionalProperties":true}}}},"400":{"$ref":"#/components/responses/Error"},"401":{"$ref":"#/components/responses/Error"},"403":{"$ref":"#/components/responses/Error"},"404":{"$ref":"#/components/responses/Error"},"409":{"$ref":"#/components/responses/Error"},"422":{"$ref":"#/components/responses/Error"},"429":{"$ref":"#/components/responses/Error"},"503":{"$ref":"#/components/responses/Error"}}});
        let mut parameters = vec![];
        if path.contains("{id}") {
            parameters.push(json!({"name":"id","in":"path","required":true,"schema":{"type":"string","format":"uuid"}}));
        }
        if path.contains("{address}") {
            parameters.push(
                json!({"name":"address","in":"path","required":true,"schema":{"type":"string"}}),
            );
        }
        if path.contains("{kind}") {
            parameters.push(json!({"name":"kind","in":"path","required":true,"schema":{"type":"string","enum":["model","launch","escrow","reserve"]}}));
        }
        if path.contains("{step}") {
            parameters.push(json!({"name":"step","in":"path","required":true,"schema":{"type":"string","enum":["fee_vault","config","pool","migration"]}}));
        }
        if auth {
            operation["security"] = json!([{"walletSession":[]}]);
            if method != "get" {
                parameters.push(json!({"name":"X-CSRF-Token","in":"header","required":true,"schema":{"type":"string"}}));
            }
        }
        if path == "/simulations" || path == "/simulations/grids" || path == "/factory/launches" {
            parameters.push(json!({"name":"Idempotency-Key","in":"header","required":true,"schema":{"type":"string","minLength":1,"maxLength":128}}));
        }
        if path == "/markets" {
            parameters.push(json!({"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":100,"default":20}}));
            parameters.push(json!({"name":"after","in":"query","schema":{"type":"string"}}));
        }
        if path == "/model-versions" {
            parameters.push(json!({"name":"limit","in":"query","schema":{"type":"integer","minimum":1,"maximum":100,"default":25}}));
            parameters.push(json!({"name":"offset","in":"query","schema":{"type":"integer","minimum":0,"maximum":100000,"default":0}}));
        }
        if !parameters.is_empty() {
            operation["parameters"] = json!(parameters);
        }
        if !input.is_empty() {
            operation["requestBody"] = json!({"required":true,"content":{"application/json":{"schema":{"$ref":format!("#/components/schemas/{input}")}}}});
        }
        if path.ends_with("/events") {
            operation["responses"]["200"]["content"] =
                json!({"text/event-stream":{"schema":{"type":"string"}}});
        }
        paths
            .entry(format!("/api/v1{path}"))
            .or_insert_with(|| json!({}))[method] = operation;
    }
    let mut schemas = json!({
        "FactoryInput":schema::<crate::factory::FactoryInput>(),
        "Economy":schema::<depthguard_domain::economy::Economy>(),
        "ContractPrepare":schema::<crate::modules::PrepareInput>(),"ContractEncode":schema::<crate::modules::EncodeInput>(),"RedemptionInput":schema::<crate::modules::RedemptionInput>(),
        "Compiled":schema::<depthguard_domain::economy::Compiled>(),
        "Case":schema::<depthguard_application::research::Case>(),
        "GridRequest":schema::<depthguard_application::research::GridRequest>(),
        "ResearchRequest":schema::<depthguard_application::research::ResearchRequest>(),
        "ChallengeInput":schema::<crate::auth::ChallengeInput>(),"VerifyInput":schema::<crate::auth::VerifyInput>(),
        "CreateModel":schema::<crate::models::CreateModel>(),"UpdateModel":schema::<crate::models::UpdateModel>(),"ForkInput":schema::<crate::models::ForkInput>(),
        "LaunchInput":schema::<crate::launches::LaunchInput>(),
        "QuoteRequest":schema::<crate::markets::QuoteRequest>(),"DatasetInput":schema::<crate::research::DatasetInput>(),"SweepInput":schema::<crate::transactions::SweepInput>(),"SubmitInput":schema::<crate::transactions::SubmitInput>()
    });
    schemas["NativeInput"] = json!({"type":"object","additionalProperties":false,"required":["protocol","root","parameters"],"properties":{"protocol":{"type":"string","enum":["dbc","damm-v2"]},"root":{"type":"string"},"parameters":{"type":"object","additionalProperties":true}}});
    let mut definitions = serde_json::Map::new();
    for value in schemas.as_object_mut().expect("Schema object").values_mut() {
        if let Some(defs) = value
            .as_object_mut()
            .expect("Schema object")
            .remove("$defs")
        {
            for (name, definition) in defs.as_object().expect("Definitions object") {
                definitions
                    .entry(name.clone())
                    .or_insert_with(|| definition.clone());
            }
        }
        value
            .as_object_mut()
            .expect("Schema object")
            .remove("$schema");
    }
    for (name, definition) in definitions {
        schemas
            .as_object_mut()
            .expect("Schema object")
            .entry(name)
            .or_insert(definition);
    }
    rewrite_refs(&mut schemas);
    json!({"openapi":"3.1.0","info":{"title":"DepthGuard Backend","version":"0.1.0","description":"Wallet authenticated model registry, research and native Meteora quotes. Capability endpoints identify release gates."},"paths":paths,"components":{"schemas":schemas,"securitySchemes":{"walletSession":{"type":"apiKey","in":"cookie","name":"depthguard_session"}},"responses":{"Error":{"description":"Structured error; internal details and credentials are excluded","content":{"application/json":{"schema":{"type":"object","required":["error"],"properties":{"error":{"type":"object","required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"}}}}}}}}}}})
}
fn rewrite_refs(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get_mut("$ref")
                && reference.starts_with("#/$defs/")
            {
                *reference = reference.replacen("#/$defs/", "#/components/schemas/", 1);
            }
            for child in map.values_mut() {
                rewrite_refs(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                rewrite_refs(child);
            }
        }
        _ => {}
    }
}
