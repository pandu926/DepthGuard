CREATE TABLE contract_accounts (
 cluster text NOT NULL, address text NOT NULL, kind text NOT NULL CHECK(kind IN ('model','launch','escrow','reserve')),
 program_id text NOT NULL, data jsonb NOT NULL, context_slot bigint NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(cluster,address)
);
CREATE TABLE contract_receipts (
 transaction_id uuid PRIMARY KEY REFERENCES prepared_transactions(id),
 indexed_at timestamptz NOT NULL DEFAULT now()
);
