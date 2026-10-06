use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{HeaderMap, header::SET_COOKIE, request::Parts},
};
use chrono::{DateTime, Utc};
use depthguard_application::auth::{random_token, token_hash, verify_wallet};
use depthguard_domain::money::public_key;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use subtle::ConstantTimeEq;
use uuid::Uuid;
#[derive(Clone, Debug)]
pub struct Actor {
    pub id: Uuid,
    pub wallet: String,
    pub role: String,
}
impl FromRequestParts<AppState> for Actor {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        let token = session_token(&parts.headers).ok_or_else(ApiError::unauthorized)?;
        let row=sqlx::query("SELECT u.id,u.wallet,u.role,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now()")
            .bind(token_hash(&token)).fetch_optional(&state.pool).await?.ok_or_else(ApiError::unauthorized)?;
        if !["GET", "HEAD", "OPTIONS"].contains(&parts.method.as_str()) {
            let origin = parts
                .headers
                .get("origin")
                .and_then(|h| h.to_str().ok())
                .ok_or_else(ApiError::forbidden)?;
            if origin != state.config.origin {
                return Err(ApiError::forbidden());
            }
            let csrf = parts
                .headers
                .get("x-csrf-token")
                .and_then(|h| h.to_str().ok())
                .ok_or_else(ApiError::forbidden)?;
            let actual = token_hash(csrf);
            let expected: String = row.get("csrf_hash");
            if !bool::from(actual.as_bytes().ct_eq(expected.as_bytes())) {
                return Err(ApiError::forbidden());
            }
        }
        Ok(Self {
            id: row.get("id"),
            wallet: row.get("wallet"),
            role: row.get("role"),
        })
    }
}
fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            part.trim()
                .strip_prefix("depthguard_session=")
                .map(str::to_owned)
        })
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChallengeInput {
    wallet: String,
}
pub async fn challenge(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ChallengeInput>,
) -> ApiResult<Json<Value>> {
    check_origin(&s, &headers)?;
    public_key(&input.wallet).map_err(ApiError::bad)?;
    let mut tx = s.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,2))")
        .bind(&input.wallet)
        .execute(&mut *tx)
        .await?;
    let recent:i64=sqlx::query_scalar("SELECT count(*) FROM auth_challenges WHERE wallet=$1 AND created_at>now()-interval '5 minutes'").bind(&input.wallet).fetch_one(&mut *tx).await?;
    if recent >= 10 {
        return Err(ApiError {
            status: axum::http::StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: "Too many authentication challenges".into(),
        });
    }
    let id = Uuid::new_v4();
    let nonce = random_token();
    let issued = Utc::now();
    let expires = issued + chrono::Duration::minutes(5);
    let message = format!(
        "DepthGuard wallet authentication\nOrigin: {}\nWallet: {}\nCluster: {}\nNonce: {}\nIssued At: {}\nExpiration Time: {}\nRequest ID: {}",
        s.config.origin,
        input.wallet,
        s.config.cluster,
        nonce,
        issued.to_rfc3339(),
        expires.to_rfc3339(),
        id
    );
    sqlx::query("INSERT INTO auth_challenges(id,wallet,message,expires_at) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(input.wallet)
        .bind(&message)
        .bind(expires)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"message":message,"expires_at":expires}),
    ))
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VerifyInput {
    id: Uuid,
    signature: String,
}
pub async fn verify(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<VerifyInput>,
) -> ApiResult<(HeaderMap, Json<Value>)> {
    check_origin(&s, &headers)?;
    let mut tx = s.pool.begin().await?;
    let row = sqlx::query(
        "SELECT wallet,message,expires_at,consumed_at FROM auth_challenges WHERE id=$1 FOR UPDATE",
    )
    .bind(input.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::unauthorized)?;
    let consumed: Option<DateTime<Utc>> = row.get("consumed_at");
    let expires: DateTime<Utc> = row.get("expires_at");
    if consumed.is_some() || expires < Utc::now() {
        return Err(ApiError::unauthorized());
    }
    let wallet: String = row.get("wallet");
    let message: String = row.get("message");
    // Consume even failed verification to prevent repeated online signature guesses.
    sqlx::query("UPDATE auth_challenges SET consumed_at=now() WHERE id=$1")
        .bind(input.id)
        .execute(&mut *tx)
        .await?;
    if verify_wallet(&wallet, &message, &input.signature).is_err() {
        tx.commit().await?;
        return Err(ApiError::unauthorized());
    }
    let user:Uuid=sqlx::query_scalar("INSERT INTO users(id,wallet) VALUES($1,$2) ON CONFLICT(wallet) DO UPDATE SET wallet=EXCLUDED.wallet RETURNING id").bind(Uuid::new_v4()).bind(&wallet).fetch_one(&mut *tx).await?;
    let token = random_token();
    let csrf = random_token();
    let expires = Utc::now() + chrono::Duration::hours(24);
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4)",
    )
    .bind(token_hash(&token))
    .bind(user)
    .bind(token_hash(&csrf))
    .bind(expires)
    .execute(&mut *tx)
    .await?;
    depthguard_infrastructure::store::audit(&mut tx, user, "auth.login", input.id).await?;
    tx.commit().await?;
    let mut response_headers = HeaderMap::new();
    let secure = if s.config.cookie_secure {
        "; Secure"
    } else {
        ""
    };
    response_headers.insert(
        SET_COOKIE,
        format!(
            "depthguard_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400{secure}"
        )
        .parse()
        .map_err(|_| ApiError::bad("Invalid cookie"))?,
    );
    Ok((
        response_headers,
        Json(json!({"user_id":user,"wallet":wallet,"csrf_token":csrf,"expires_at":expires})),
    ))
}
pub async fn me(actor: Actor) -> Json<Value> {
    Json(json!({"id":actor.id,"wallet":actor.wallet,"role":actor.role}))
}
pub async fn logout(
    State(s): State<AppState>,
    _actor: Actor,
    headers: HeaderMap,
) -> ApiResult<(HeaderMap, Json<Value>)> {
    let token = session_token(&headers).ok_or_else(ApiError::unauthorized)?;
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(token_hash(&token))
        .execute(&s.pool)
        .await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        SET_COOKIE,
        "depthguard_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
            .parse()
            .unwrap(),
    );
    Ok((headers, Json(json!({"logged_out":true}))))
}
fn check_origin(s: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    if headers.get("origin").and_then(|h| h.to_str().ok()) != Some(s.config.origin.as_str()) {
        return Err(ApiError::forbidden());
    }
    Ok(())
}
