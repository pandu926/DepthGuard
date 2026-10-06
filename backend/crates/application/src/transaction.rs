use depthguard_domain::money::public_key;
use ed25519_dalek::{Signature, VerifyingKey};
/// A stored message is the signing authority. A client cannot replace its instructions or blockhash.
pub fn verify_signed_wire(
    wire: &[u8],
    message: &[u8],
    signers: &[String],
) -> Result<String, String> {
    if wire.len() > 1232
        || signers.is_empty()
        || signers.len() >= 128
        || wire.first() != Some(&(signers.len() as u8))
    {
        return Err("Invalid transaction envelope".into());
    }
    let start = 1 + signers.len() * 64;
    if wire.get(start..) != Some(message) {
        return Err("Signed message differs from the prepared message".into());
    }
    for (i, wallet) in signers.iter().enumerate() {
        let key = VerifyingKey::from_bytes(&public_key(wallet)?)
            .map_err(|_| "Invalid transaction signer")?;
        let signature = Signature::from_slice(&wire[1 + i * 64..1 + (i + 1) * 64])
            .map_err(|_| "Invalid transaction signature")?;
        key.verify_strict(message, &signature)
            .map_err(|_| "Transaction signature verification failed")?;
    }
    Ok(bs58::encode(&wire[1..65]).into_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;
    #[test]
    fn rejects_message_and_signature_tampering() {
        let key = SigningKey::generate(&mut OsRng);
        let signers = vec![bs58::encode(key.verifying_key().as_bytes()).into_string()];
        let message = b"prepared native instruction";
        let mut wire = vec![1];
        wire.extend_from_slice(&key.sign(message).to_bytes());
        wire.extend_from_slice(message);
        assert!(verify_signed_wire(&wire, message, &signers).is_ok());
        let mut changed = wire.clone();
        *changed.last_mut().unwrap() ^= 1;
        assert!(verify_signed_wire(&changed, message, &signers).is_err());
        wire[1] ^= 1;
        assert!(verify_signed_wire(&wire, message, &signers).is_err());
    }
}
