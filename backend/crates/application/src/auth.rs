use depthguard_domain::money::public_key;
use ed25519_dalek::{Signature, VerifyingKey};
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
pub fn random_token() -> String {
    let mut data = [0u8; 32];
    OsRng.fill_bytes(&mut data);
    hex::encode(data)
}
pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
pub fn verify_wallet(wallet: &str, message: &str, signature: &str) -> Result<(), String> {
    if !(64..=88).contains(&signature.len()) {
        return Err("Invalid signature length".into());
    }
    let key = VerifyingKey::from_bytes(&public_key(wallet)?).map_err(|_| "Invalid signing key")?;
    let bytes = bs58::decode(signature)
        .into_vec()
        .map_err(|_| "Invalid signature encoding")?;
    let signature = Signature::from_slice(&bytes).map_err(|_| "Invalid signature length")?;
    key.verify_strict(message.as_bytes(), &signature)
        .map_err(|_| "Signature verification failed".into())
}
