use axum::{Json, Router, extract::State, routing::post};
use depthguard_infrastructure::{relay, rpc::Rpc, store::Job};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::future::IntoFuture;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use uuid::Uuid;
#[derive(Clone)]
struct Fake {
    sends: Arc<AtomicUsize>,
    height: Arc<AtomicUsize>,
    missing: Option<String>,
    acknowledged_drop: Option<String>,
}
async fn handle(State(state): State<Fake>, Json(request): Json<Value>) -> Json<Value> {
    let result = match request["method"].as_str().unwrap() {
        "getGenesisHash" => json!("11111111111111111111111111111111"),
        "getBlockHeight" => json!(state.height.load(Ordering::SeqCst)),
        "getSignatureStatuses" => {
            let sends = state.sends.load(Ordering::SeqCst);
            if sends > 0 && !(sends == 1 && state.acknowledged_drop.is_some()) {
                json!({"value":[{"slot":42,"err":null,"confirmationStatus":"finalized"}]})
            } else {
                json!({"value":[null]})
            }
        }
        "simulateTransaction" => json!({"value":{"err":null}}),
        "sendTransaction" => {
            state.sends.fetch_add(1, Ordering::SeqCst);
            if let Some(signature) = &state.acknowledged_drop {
                return Json(json!({"jsonrpc":"2.0","id":request["id"],"result":signature}));
            }
            // The send landed, but the RPC reply was lost. Reconciliation must resolve this.
            return Json(
                json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32005,"message":"Node reply unavailable"}}),
            );
        }
        "getTransaction" => {
            if state.missing.as_deref() == request["params"][0].as_str() {
                return Json(json!({"jsonrpc":"2.0","id":request["id"],"result":null}));
            }
            json!({"slot":42,"transaction":{"signatures":[request["params"][0]],"message":{"accountKeys":[]}},"meta":{"err":null,"innerInstructions":[]}})
        }
        _ => panic!("Unexpected RPC method"),
    };
    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
}
#[sqlx::test(migrations = "../../migrations")]
async fn unknown_send_outcome_reconciles_without_a_second_send(pool: PgPool) {
    let state = Fake {
        sends: Arc::new(AtomicUsize::new(0)),
        height: Arc::new(AtomicUsize::new(100)),
        missing: None,
        acknowledged_drop: None,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/", post(handle))
                .with_state(state.clone()),
        )
        .into_future(),
    );
    let rpc = Rpc::new(vec![format!("http://127.0.0.1:{port}")]).unwrap();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,wallet) VALUES($1,$2)")
        .bind(user)
        .bind("11111111111111111111111111111111")
        .execute(&pool)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let signature = bs58::encode([1u8; 64]).into_string();
    let wire = vec![1u8; 100];
    sqlx::query("INSERT INTO prepared_transactions(id,owner_id,cluster,state,message,required_signers,signed_wire,signature,last_valid_block_height,summary) VALUES($1,$2,'localnet','submitted',$3,'[]',$4,$5,200,'{}')").bind(id).bind(user).bind(vec![0u8]).bind(&wire).bind(signature).execute(&pool).await.unwrap();
    let job = Job {
        id: Uuid::new_v4(),
        kind: "broadcast".into(),
        payload: json!({"transaction_id":id}),
        attempts: 1,
    };
    assert!(
        relay::broadcast(&pool, &rpc, "localnet", &job)
            .await
            .is_err()
    );
    relay::broadcast(&pool, &rpc, "localnet", &job)
        .await
        .unwrap();
    relay::reconcile(&pool, &rpc, "localnet").await.unwrap();
    let stored: (String, Vec<u8>) =
        sqlx::query_as("SELECT state,signed_wire FROM prepared_transactions WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, ("finalized".into(), wire));
    assert_eq!(state.sends.load(Ordering::SeqCst), 1);
    // Finalized block-height expiry is terminal and never triggers a new send.
    state.sends.store(0, Ordering::SeqCst);
    state.height.store(300, Ordering::SeqCst);
    sqlx::query("UPDATE prepared_transactions SET state='submitted' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    relay::broadcast(&pool, &rpc, "localnet", &job)
        .await
        .unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM prepared_transactions WHERE id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "expired");
    server.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn unavailable_old_receipt_does_not_starve_other_transactions(pool: PgPool) {
    let missing = bs58::encode([9u8; 64]).into_string();
    let available = bs58::encode([10u8; 64]).into_string();
    let state = Fake {
        sends: Arc::new(AtomicUsize::new(1)),
        height: Arc::new(AtomicUsize::new(100)),
        missing: Some(missing.clone()),
        acknowledged_drop: None,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new().route("/", post(handle)).with_state(state),
        )
        .into_future(),
    );
    let rpc = Rpc::new(vec![format!("http://127.0.0.1:{port}")]).unwrap();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,wallet) VALUES($1,$2)")
        .bind(user)
        .bind("11111111111111111111111111111111")
        .execute(&pool)
        .await
        .unwrap();
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    for (id, signature) in [(first, missing), (second, available)] {
        sqlx::query("INSERT INTO prepared_transactions(id,owner_id,cluster,state,message,required_signers,signed_wire,signature,last_valid_block_height,summary,updated_at) VALUES($1,$2,'localnet','confirmed',$3,'[]',$4,$5,200,'{}',now()-interval '2 minutes')").bind(id).bind(user).bind(vec![0u8]).bind(vec![1u8;100]).bind(signature).execute(&pool).await.unwrap();
    }
    relay::reconcile(&pool, &rpc, "localnet").await.unwrap();
    let unchanged: String =
        sqlx::query_scalar("SELECT state FROM prepared_transactions WHERE id=$1")
            .bind(first)
            .fetch_one(&pool)
            .await
            .unwrap();
    let progressed: String =
        sqlx::query_scalar("SELECT state FROM prepared_transactions WHERE id=$1")
            .bind(second)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        unchanged, "confirmed",
        "Missing history must not invent finalization"
    );
    assert_eq!(
        progressed, "finalized",
        "An unrelated valid receipt must still progress"
    );
    let rotated: bool = sqlx::query_scalar(
        "SELECT updated_at>now()-interval '1 minute' FROM prepared_transactions WHERE id=$1",
    )
    .bind(first)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(rotated);
    server.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn acknowledged_but_dropped_packet_requeues_the_same_signed_wire(pool: PgPool) {
    let signature = bs58::encode([2u8; 64]).into_string();
    let state = Fake {
        sends: Arc::new(AtomicUsize::new(0)),
        height: Arc::new(AtomicUsize::new(100)),
        missing: None,
        acknowledged_drop: Some(signature.clone()),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/", post(handle))
                .with_state(state.clone()),
        )
        .into_future(),
    );
    let rpc = Rpc::new(vec![format!("http://127.0.0.1:{port}")]).unwrap();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,wallet) VALUES($1,$2)")
        .bind(user)
        .bind("11111111111111111111111111111111")
        .execute(&pool)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let wire = vec![2u8; 100];
    sqlx::query("INSERT INTO prepared_transactions(id,owner_id,cluster,state,message,required_signers,signed_wire,signature,last_valid_block_height,summary) VALUES($1,$2,'localnet','submitted',$3,'[]',$4,$5,200,'{}')").bind(id).bind(user).bind(vec![0u8]).bind(&wire).bind(&signature).execute(&pool).await.unwrap();
    let job_id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs(id,kind,payload,max_attempts) VALUES($1,'broadcast',$2,3)")
        .bind(job_id)
        .bind(json!({"transaction_id":id}))
        .execute(&pool)
        .await
        .unwrap();
    let owner = Uuid::new_v4();
    let job = relay::claim_broadcast(&pool, owner).await.unwrap().unwrap();
    relay::broadcast(&pool, &rpc, "localnet", &job)
        .await
        .unwrap();
    depthguard_infrastructure::store::finish(&pool, job.id, owner)
        .await
        .unwrap();
    relay::reconcile(&pool, &rpc, "localnet").await.unwrap();
    let pending: (String, i32) = sqlx::query_as("SELECT state,attempts FROM jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pending, ("pending".into(), 1));
    assert_eq!(state.sends.load(Ordering::SeqCst), 1);
    sqlx::query("UPDATE jobs SET run_after=now() WHERE id=$1")
        .bind(job_id)
        .execute(&pool)
        .await
        .unwrap();
    let retried = relay::claim_broadcast(&pool, owner).await.unwrap().unwrap();
    assert_eq!(retried.id, job_id);
    relay::broadcast(&pool, &rpc, "localnet", &retried)
        .await
        .unwrap();
    depthguard_infrastructure::store::finish(&pool, retried.id, owner)
        .await
        .unwrap();
    relay::reconcile(&pool, &rpc, "localnet").await.unwrap();
    let stored: (String, Vec<u8>, String) =
        sqlx::query_as("SELECT state,signed_wire,signature FROM prepared_transactions WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, ("finalized".into(), wire, signature));
    assert_eq!(state.sends.load(Ordering::SeqCst), 2);
    assert!(
        relay::claim_broadcast(&pool, owner)
            .await
            .unwrap()
            .is_none()
    );
    server.abort();
}
