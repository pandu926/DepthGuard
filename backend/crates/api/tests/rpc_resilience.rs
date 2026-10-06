use axum::{Json, Router, extract::State, routing::post};
use depthguard_infrastructure::rpc::Rpc;
use serde_json::{Value, json};
use std::{
    future::IntoFuture,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Clone)]
struct Provider {
    calls: Arc<AtomicUsize>,
    genesis: &'static str,
}

async fn handle(State(provider): State<Provider>, Json(request): Json<Value>) -> Json<Value> {
    if request["method"] == "getGenesisHash" {
        return Json(json!({"jsonrpc":"2.0", "id":request["id"], "result":provider.genesis}));
    }
    let attempt = provider.calls.fetch_add(1, Ordering::SeqCst);
    if attempt == 0 || request["method"] == "sendTransaction" {
        Json(json!({"jsonrpc":"2.0", "id":request["id"], "error":{"code":-32005}}))
    } else {
        Json(json!({"jsonrpc":"2.0", "id":request["id"], "result":123}))
    }
}

async fn provider(
    genesis: &'static str,
) -> (
    String,
    Provider,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let state = Provider {
        calls: Arc::new(AtomicUsize::new(0)),
        genesis,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/", post(handle))
                .with_state(state.clone()),
        )
        .into_future(),
    );
    (url, state, server)
}

#[tokio::test]
async fn transient_reads_retry_but_ambiguous_sends_do_not() {
    let (url, provider, server) = provider("11111111111111111111111111111111").await;
    let rpc = Rpc::new(vec![url]).unwrap();
    rpc.verify_cluster("localnet").await.unwrap();
    assert_eq!(
        rpc.call("getBlockHeight", json!([])).await.unwrap(),
        json!(123)
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert!(rpc.call("sendTransaction", json!(["wire"])).await.is_err());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    server.abort();
}

#[tokio::test]
async fn fallback_with_a_different_genesis_is_never_used() {
    let (first_url, first, first_server) = provider("11111111111111111111111111111111").await;
    let (wrong_url, wrong, wrong_server) =
        provider("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG").await;
    let rpc = Rpc::new(vec![first_url, wrong_url]).unwrap();
    rpc.verify_cluster("localnet").await.unwrap();
    assert_eq!(
        rpc.call("getBlockHeight", json!([])).await.unwrap(),
        json!(123)
    );
    assert_eq!(first.calls.load(Ordering::SeqCst), 2);
    assert_eq!(wrong.calls.load(Ordering::SeqCst), 0);
    first_server.abort();
    wrong_server.abort();
}
