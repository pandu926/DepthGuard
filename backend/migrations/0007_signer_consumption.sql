-- Account-creation keys must survive long graduation periods, then be erased after verified setup.
ALTER TABLE launch_account_signers DROP COLUMN expires_at;
ALTER TABLE launch_account_signers ADD COLUMN consumed_at timestamptz;
ALTER TABLE launch_account_signers ADD CONSTRAINT signer_payload_lifecycle
    CHECK ((consumed_at IS NULL AND octet_length(encrypted_key)=60) OR
           (consumed_at IS NOT NULL AND octet_length(encrypted_key)=0));
