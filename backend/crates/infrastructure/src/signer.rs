use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result};
use ed25519_dalek::{Signer, SigningKey};
use rand::{RngCore, rngs::OsRng};
use serde_json::Value;
use uuid::Uuid;
/// Only fresh account-creation keys are stored. User and keeper wallet keys never enter this service.
pub fn create(key: &[u8; 32], launch: Uuid, purpose: &str) -> Result<(String, Vec<u8>)> {
    let signer = SigningKey::generate(&mut OsRng);
    let public = bs58::encode(signer.verifying_key().as_bytes()).into_string();
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid encryption key"))?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let aad = format!("{launch}:{purpose}:{public}");
    let encrypted = cipher
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &signer.to_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("Account signer encryption failed"))?;
    let mut payload = nonce.to_vec();
    payload.extend_from_slice(&encrypted);
    Ok((public, payload))
}
pub struct Identity<'a> {
    pub launch: Uuid,
    pub purpose: &'a str,
    pub public: &'a str,
}
pub fn partial_sign(
    key: &[u8; 32],
    identity: Identity<'_>,
    encrypted: &[u8],
    message: &[u8],
    signers: &Value,
    wire: &mut [u8],
) -> Result<()> {
    let Identity {
        launch,
        purpose,
        public,
    } = identity;
    if encrypted.len() < 12 {
        anyhow::bail!("Invalid encrypted account signer");
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid encryption key"))?;
    let aad = format!("{launch}:{purpose}:{public}");
    let bytes = cipher
        .decrypt(
            &Nonce::from(<[u8; 12]>::try_from(&encrypted[..12])?),
            Payload {
                msg: &encrypted[12..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("Account signer authentication failed"))?;
    let signer = SigningKey::from_bytes(
        &bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid decrypted account signer"))?,
    );
    let list = signers.as_array().context("Required signers missing")?;
    let index = list
        .iter()
        .position(|p| p.as_str() == Some(public))
        .context("Account signer is absent from transaction")?;
    let target = wire
        .get_mut(1 + index * 64..1 + (index + 1) * 64)
        .context("Invalid signer envelope")?;
    target.copy_from_slice(&signer.sign(message).to_bytes());
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_signers_cannot_be_moved_between_launches() {
        let key = [7u8; 32];
        let id = Uuid::new_v4();
        let (public, encrypted) = create(&key, id, "mint").unwrap();
        let signers = serde_json::json!([public]);
        let mut wire = vec![0; 65];
        assert!(
            partial_sign(
                &key,
                Identity {
                    launch: Uuid::new_v4(),
                    purpose: "mint",
                    public: &public
                },
                &encrypted,
                b"message",
                &signers,
                &mut wire
            )
            .is_err()
        );
        partial_sign(
            &key,
            Identity {
                launch: id,
                purpose: "mint",
                public: &public,
            },
            &encrypted,
            b"message",
            &signers,
            &mut wire,
        )
        .unwrap();
        assert!(wire[1..].iter().any(|v| *v != 0));
    }
}
