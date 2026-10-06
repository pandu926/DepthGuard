ALTER TABLE model_versions ADD CONSTRAINT model_content_unique UNIQUE(model_id,content_hash);
CREATE INDEX research_owner_status ON research_jobs(owner_id,status);
CREATE INDEX models_owner ON models(owner_id,updated_at DESC);
CREATE INDEX prepared_reconciliation ON prepared_transactions(cluster,updated_at) WHERE state IN ('submitted','confirmed');
CREATE INDEX fee_recipient ON fee_accounting_entries(recipient_wallet,cluster) WHERE finalized;
