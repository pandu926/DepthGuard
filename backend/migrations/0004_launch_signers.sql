CREATE TABLE launch_account_signers (
    launch_id uuid NOT NULL REFERENCES launches,
    purpose text NOT NULL CHECK (purpose IN ('config','mint','first_position','second_position')),
    public_key text NOT NULL,
    encrypted_key bytea NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
    PRIMARY KEY(launch_id,purpose),
    UNIQUE(public_key)
);
ALTER TABLE prepared_transactions ADD COLUMN workflow_step text;
CREATE UNIQUE INDEX one_prepared_launch_step ON prepared_transactions(launch_id,workflow_step) WHERE launch_id IS NOT NULL AND state IN ('prepared','submitted','confirmed');
ALTER TABLE workflow_steps ADD COLUMN transaction_id uuid REFERENCES prepared_transactions;
