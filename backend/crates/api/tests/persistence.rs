use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use depthguard_api::{AppState, router};
use depthguard_infrastructure::{config::Config, store};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:8800";
struct Session {
    wallet: String,
    cookie: String,
    csrf: String,
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    session: Option<&Session>,
    key: Option<&str>,
) -> (StatusCode, Value, Option<String>) {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header("origin", ORIGIN)
        .header("content-type", "application/json");
    if let Some(s) = session {
        r = r
            .header("cookie", &s.cookie)
            .header("x-csrf-token", &s.csrf);
    }
    if let Some(k) = key {
        r = r.header("idempotency-key", k);
    }
    let response = app
        .clone()
        .oneshot(r.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|h| h.to_str().unwrap().split(';').next().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
    )
}
async fn login(app: &Router) -> Session {
    let key = SigningKey::generate(&mut OsRng);
    let wallet = bs58::encode(key.verifying_key().as_bytes()).into_string();
    let (status, c, _) = request(
        app,
        "POST",
        "/api/v1/auth/challenges",
        json!({"wallet":wallet}),
        None,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let signature = bs58::encode(
        key.sign(c["message"].as_str().unwrap().as_bytes())
            .to_bytes(),
    )
    .into_string();
    let body = json!({"id":c["id"],"signature":signature});
    let (status, result, cookie) =
        request(app, "POST", "/api/v1/auth/verify", body.clone(), None, None).await;
    assert_eq!(status, 200);
    let (status, _, _) = request(app, "POST", "/api/v1/auth/verify", body, None, None).await;
    assert_eq!(status, 401, "Wallet challenge replay must fail");
    Session {
        wallet,
        cookie: cookie.unwrap(),
        csrf: result["csrf_token"].as_str().unwrap().into(),
    }
}
fn economy(author: &str) -> Value {
    json!({"schema_version":1,"mechanism":"meme","base_decimals":6,"quote_decimals":9,"supply":"1000000000000000","sqrt_start_price":"1844674407370955","curve":[{"sqrt_price":"18446744073709551","liquidity":"1000000000000000000000000000000"}],"migration_quote_threshold":"10000000","trade_fee_bps":25,"migration_fee_pct":0,"compounding_fee_bps":0,"fee_policy":{"author":author,"launcher_bps":8000,"author_bps":1000,"platform_bps":1000}})
}
#[sqlx::test(migrations = "../../migrations")]
async fn wallet_model_isolation_fork_and_research_idempotency(pool: PgPool) {
    let config = Config {
        database_url: String::new(),
        bind: "127.0.0.1:8800".parse().unwrap(),
        origin: ORIGIN.into(),
        cluster: "localnet".into(),
        cookie_secure: false,
        rpc_urls: vec!["http://127.0.0.1:8899".into()],
        artifacts_dir: "artifacts".into(),
        chain_writes: false,
        contracts_enabled: false,
        encryption_key: Some([9; 32]),
        platform_wallet: Some(
            bs58::encode(SigningKey::generate(&mut OsRng).verifying_key().as_bytes()).into_string(),
        ),
        damm_config: None,
    };
    let app = router(AppState::new(pool.clone(), config).unwrap());
    let a = login(&app).await;
    let b = login(&app).await;
    let model = economy(&a.wallet);
    let (status, created, _) = request(
        &app,
        "POST",
        "/api/v1/models",
        json!({"name":"Alpha","economy":model}),
        Some(&a),
        None,
    )
    .await;
    assert_eq!(status, 200);
    let id = created["id"].as_str().unwrap();
    let (status, mine, _) = request(
        &app,
        "GET",
        "/api/v1/me/models?limit=1",
        Value::Null,
        Some(&a),
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(mine["items"][0]["id"], created["id"]);
    let (status, other, _) = request(
        &app,
        "GET",
        "/api/v1/me/models",
        Value::Null,
        Some(&b),
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        other["items"].as_array().unwrap().len(),
        0,
        "Private creator models must not leak across accounts"
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/me/models?limit=101",
            Value::Null,
            Some(&a),
            None
        )
        .await
        .0,
        422
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/tokens?offset=-1",
            Value::Null,
            None,
            None
        )
        .await
        .0,
        422
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/v1/factory/launches/{}/next", Uuid::new_v4()),
            json!({}),
            Some(&a),
            None
        )
        .await
        .0,
        503,
        "Disabled factory must reject preparation before RPC access"
    );

    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/v1/models/{id}"),
            Value::Null,
            Some(&b),
            None
        )
        .await
        .0,
        404
    );
    let wrong_csrf = Session {
        wallet: a.wallet.clone(),
        cookie: a.cookie.clone(),
        csrf: "invalid".into(),
    };
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/v1/models/{id}/publish"),
            Value::Null,
            Some(&wrong_csrf),
            None
        )
        .await
        .0,
        403
    );
    let (status, published, _) = request(
        &app,
        "POST",
        &format!("/api/v1/models/{id}/publish"),
        Value::Null,
        Some(&a),
        None,
    )
    .await;
    assert_eq!(status, 200);
    let version = published["id"].as_str().unwrap();
    let (status,launch,_) = request(&app,"POST","/api/v1/launches",json!({"model_version_id":version,"name":"Native Alpha","symbol":"NALPHA","uri":"https://example.com/alpha.json","quote_mint":"So11111111111111111111111111111111111111112"}),Some(&a),None).await;
    assert_eq!(status, 200, "{launch}");
    let launch_id = launch["id"].as_str().unwrap();
    assert!(!launch.to_string().contains("encrypted_key"));
    let stored:i64=sqlx::query_scalar("SELECT count(*) FROM launch_account_signers WHERE launch_id=$1 AND octet_length(encrypted_key)=60").bind(launch_id.parse::<Uuid>().unwrap()).fetch_one(&pool).await.unwrap();
    assert_eq!(stored, 4);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/v1/launches/{launch_id}"),
            Value::Null,
            Some(&b),
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/v1/launches/{launch_id}/steps/pool/prepare"),
            Value::Null,
            Some(&a),
            None
        )
        .await
        .0,
        409
    );
    let immutability =
        sqlx::query("UPDATE model_versions SET content_hash=repeat('f',64) WHERE id=$1")
            .bind(version.parse::<Uuid>().unwrap())
            .execute(&pool)
            .await;
    assert!(immutability.is_err());
    let (status, fork, _) = request(
        &app,
        "POST",
        &format!("/api/v1/model-versions/{version}/fork"),
        json!({"name":"Fork"}),
        Some(&b),
        None,
    )
    .await;
    assert_eq!(status, 200);
    let fork_id = fork["id"].as_str().unwrap();
    let mut changed = economy(&b.wallet);
    changed["fee_policy"]["author_bps"] = json!(0);
    changed["fee_policy"]["launcher_bps"] = json!(9000);
    assert_eq!(
        request(
            &app,
            "PATCH",
            &format!("/api/v1/models/{fork_id}"),
            json!({"name":"Stolen attribution","economy":changed,"revision":1}),
            Some(&b),
            None
        )
        .await
        .0,
        422
    );
    assert_eq!(
        request(
            &app,
            "PATCH",
            &format!("/api/v1/models/{id}"),
            json!({"name":"Stale edit","economy":model,"revision":0}),
            Some(&a),
            None
        )
        .await
        .0,
        409
    );
    let research = json!({"evidence":"analytical","seed":"42","clock":100,"cases":[{"scenario":"graduation","economy":model}],"frozen_paths":["/supply"]});
    let (status, job, _) = request(
        &app,
        "POST",
        "/api/v1/simulations",
        research.clone(),
        Some(&a),
        Some("research-1"),
    )
    .await;
    assert_eq!(status, 200);
    let duplicate = request(
        &app,
        "POST",
        "/api/v1/simulations",
        research.clone(),
        Some(&a),
        Some("research-1"),
    )
    .await;
    assert_eq!(duplicate.1, job);
    let mut changed = research;
    changed["seed"] = json!("43");
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/simulations",
            changed,
            Some(&a),
            Some("research-1")
        )
        .await
        .0,
        409
    );
    let job_id = job["id"].as_str().unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/v1/simulations/{job_id}/export"),
            Value::Null,
            Some(&b),
            None
        )
        .await
        .0,
        404
    );
    let queued: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(queued, 1);
    // Competing workers never claim the same leased job.
    let owner_a = Uuid::new_v4();
    let owner_b = Uuid::new_v4();
    let (one, two) = tokio::join!(store::claim(&pool, owner_a), store::claim(&pool, owner_b));
    let one = one.unwrap();
    let two = two.unwrap();
    assert_ne!(one.is_some(), two.is_some());
    let (leased, owner) = if let Some(job) = one {
        (job, owner_a)
    } else {
        (two.unwrap(), owner_b)
    };
    sqlx::query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(leased.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!store::heartbeat(&pool, leased.id, owner).await.unwrap());
    let recovered = store::claim(&pool, Uuid::new_v4()).await.unwrap().unwrap();
    assert_eq!(recovered.id, leased.id);
    assert_eq!(recovered.attempts, 2);
    // Slots enforce a global concurrency limit even when several processes run.
    let o1 = Uuid::new_v4();
    let o2 = Uuid::new_v4();
    let o3 = Uuid::new_v4();
    assert!(
        store::claim_research_slot(&pool, o1)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        store::claim_research_slot(&pool, o2)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        store::claim_research_slot(&pool, o3)
            .await
            .unwrap()
            .is_none()
    );
}
