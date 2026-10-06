CREATE TABLE users (
    id uuid PRIMARY KEY,
    wallet text NOT NULL UNIQUE,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'operator', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_challenges (
    id uuid PRIMARY KEY,
    wallet text NOT NULL,
    message text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX challenges_expiry ON auth_challenges(expires_at);
CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users,
    csrf_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE models (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    draft jsonb NOT NULL,
    revision bigint NOT NULL DEFAULT 1,
    source_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_versions (
    id uuid PRIMARY KEY,
    model_id uuid NOT NULL REFERENCES models,
    version integer NOT NULL,
    content_hash text NOT NULL CHECK (length(content_hash) = 64),
    economy jsonb NOT NULL,
    compiled jsonb NOT NULL,
    source_version_id uuid REFERENCES model_versions,
    author_wallet text NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (model_id, version)
);
ALTER TABLE models ADD CONSTRAINT source_version_fk FOREIGN KEY (source_version_id) REFERENCES model_versions;
CREATE FUNCTION immutable_model_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published model versions are immutable'; END $$;
CREATE TRIGGER immutable_versions BEFORE UPDATE OR DELETE ON model_versions FOR EACH ROW EXECUTE FUNCTION immutable_model_version();
CREATE TABLE datasets (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users,
    content_hash text NOT NULL,
    data jsonb NOT NULL,
    provenance jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE research_jobs (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users,
    request jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','cancelled','failed')),
    progress integer NOT NULL DEFAULT 0,
    total integer NOT NULL,
    cancel_requested boolean NOT NULL DEFAULT false,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE TABLE research_cases (
    job_id uuid NOT NULL REFERENCES research_jobs,
    case_index integer NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY (job_id, case_index)
);
CREATE TABLE artifacts (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users,
    job_id uuid REFERENCES research_jobs,
    content_hash text NOT NULL,
    media_type text NOT NULL,
    storage_key text NOT NULL UNIQUE,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','dead')),
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,
    run_after timestamptz NOT NULL DEFAULT now(),
    lease_owner uuid,
    lease_until timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim ON jobs (run_after, created_at) WHERE state IN ('pending','running');
CREATE TABLE outbox (
    id bigserial PRIMARY KEY,
    topic text NOT NULL,
    payload jsonb NOT NULL,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
    id bigserial PRIMARY KEY,
    actor_id uuid REFERENCES users,
    action text NOT NULL,
    resource_id uuid,
    details jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency_keys (
    owner_id uuid NOT NULL REFERENCES users,
    scope text NOT NULL,
    key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    request_hash text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, scope, key)
);
CREATE TABLE launches (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users,
    model_version_id uuid NOT NULL REFERENCES model_versions,
    cluster text NOT NULL,
    state text NOT NULL DEFAULT 'draft',
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workflow_steps (
    launch_id uuid NOT NULL REFERENCES launches,
    step text NOT NULL,
    state text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (launch_id, step)
);
CREATE TABLE prepared_transactions (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users,
    launch_id uuid REFERENCES launches,
    cluster text NOT NULL,
    state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','submitted','confirmed','finalized','failed','expired','verification_failed')),
    message bytea NOT NULL,
    required_signers jsonb NOT NULL,
    signed_wire bytea,
    signature text,
    last_valid_block_height bigint NOT NULL,
    summary jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cluster, signature)
);
CREATE TABLE markets (
    cluster text NOT NULL,
    address text NOT NULL,
    protocol text NOT NULL,
    launch_id uuid REFERENCES launches,
    state jsonb NOT NULL,
    context_slot bigint NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cluster, address)
);
CREATE TABLE positions (
    cluster text NOT NULL,
    address text NOT NULL,
    market_address text NOT NULL,
    owner_wallet text NOT NULL,
    state jsonb NOT NULL,
    context_slot bigint NOT NULL,
    PRIMARY KEY (cluster, address)
);
CREATE TABLE chain_events (
    cluster text NOT NULL,
    signature text NOT NULL,
    instruction_index integer NOT NULL,
    event_index integer NOT NULL,
    slot bigint NOT NULL,
    commitment text NOT NULL CHECK (commitment IN ('confirmed','finalized')),
    data jsonb NOT NULL,
    PRIMARY KEY (cluster, signature, instruction_index, event_index)
);
CREATE TABLE account_snapshots (
    cluster text NOT NULL,
    address text NOT NULL,
    slot bigint NOT NULL,
    data_hash text NOT NULL,
    data jsonb NOT NULL,
    PRIMARY KEY (cluster, address, slot)
);
CREATE TABLE indexer_cursors (
    cluster text NOT NULL,
    address text NOT NULL,
    signature text,
    slot bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cluster, address)
);
CREATE TABLE fee_vaults (
    cluster text NOT NULL,
    address text NOT NULL,
    launch_id uuid REFERENCES launches,
    quote_mint text NOT NULL,
    recipients jsonb NOT NULL,
    verified boolean NOT NULL DEFAULT false,
    PRIMARY KEY (cluster, address)
);
CREATE TABLE fee_accounting_entries (
    id uuid PRIMARY KEY,
    cluster text NOT NULL,
    vault_address text NOT NULL,
    signature text NOT NULL,
    event_index integer NOT NULL,
    entry_type text NOT NULL CHECK (entry_type IN ('funding','claim')),
    recipient_wallet text,
    amount numeric(78,0) NOT NULL CHECK (amount >= 0),
    finalized boolean NOT NULL DEFAULT false,
    UNIQUE (cluster, signature, event_index, entry_type)
);
