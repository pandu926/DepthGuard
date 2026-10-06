CREATE TABLE factory_launches (
 launch_id uuid PRIMARY KEY REFERENCES launches(id), model_address text NOT NULL,
 launch_address text NOT NULL UNIQUE, plan jsonb NOT NULL, metadata jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz
);
CREATE INDEX factory_model_address ON factory_launches(model_address);
CREATE TABLE market_observations (
 cluster text NOT NULL,address text NOT NULL,slot bigint NOT NULL,state jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(cluster,address,slot)
);
CREATE TABLE model_registry_bindings (
 cluster text NOT NULL,version_id uuid NOT NULL REFERENCES model_versions(id),
 publisher text NOT NULL,model_address text NOT NULL,json_hash text NOT NULL,
 PRIMARY KEY(cluster,version_id)
);
CREATE TABLE model_publications (
 cluster text NOT NULL,version_id uuid NOT NULL REFERENCES model_versions(id),
 publisher text NOT NULL,plan jsonb NOT NULL,PRIMARY KEY(cluster,version_id)
);
CREATE TABLE model_publication_steps (
 cluster text NOT NULL,version_id uuid NOT NULL,step text NOT NULL,
 transaction_id uuid NOT NULL REFERENCES prepared_transactions(id),
 PRIMARY KEY(cluster,version_id,step),
 FOREIGN KEY(cluster,version_id) REFERENCES model_publications(cluster,version_id)
);
ALTER TABLE launch_account_signers DROP CONSTRAINT launch_account_signers_purpose_check;
ALTER TABLE launch_account_signers ADD CONSTRAINT launch_account_signers_purpose_check
 CHECK(purpose IN ('config','mint','fee_base','first_position','second_position'));
