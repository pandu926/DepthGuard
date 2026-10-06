use crate::{AppState, error::ApiError};
use axum::{
    extract::{Request, State},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::atomic::Ordering;
pub async fn guard(State(s): State<AppState>, request: Request, next: Next) -> Response {
    s.requests.fetch_add(1, Ordering::Relaxed);
    let id = uuid::Uuid::new_v4().to_string();
    let start = std::time::Instant::now();
    let permit = s.inflight.clone().try_acquire_owned();
    let mut response = if permit.is_err() {
        ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "overloaded",
            message: "Service is busy; retry shortly".into(),
        }
        .into_response()
    } else {
        let events = request.uri().path().ends_with("/events");
        let result = if events {
            Ok(next.run(request).await)
        } else {
            tokio::time::timeout(std::time::Duration::from_secs(30), next.run(request)).await
        };
        match result {
            Ok(response) => response,
            Err(_) => ApiError {
                status: StatusCode::GATEWAY_TIMEOUT,
                code: "deadline_exceeded",
                message: "Request deadline exceeded".into(),
            }
            .into_response(),
        }
    };
    drop(permit);
    if response.status().is_client_error()
        && response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .is_none_or(|t| !t.starts_with("application/json"))
    {
        response = ApiError {
            status: response.status(),
            code: "invalid_request",
            message: "Invalid request body or route parameters".into(),
        }
        .into_response();
    }
    let micros = start.elapsed().as_micros().min(u64::MAX.into()) as u64;
    s.latency_micros.fetch_add(micros, Ordering::Relaxed);
    if response.status().is_server_error() {
        s.errors.fetch_add(1, Ordering::Relaxed);
    }
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&id).expect("UUID header"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
