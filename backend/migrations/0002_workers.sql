CREATE TABLE worker_slots (
    id integer PRIMARY KEY CHECK (id IN (1,2)),
    owner uuid,
    lease_until timestamptz
);
INSERT INTO worker_slots(id) VALUES(1),(2);
CREATE TABLE service_heartbeats (
    service text PRIMARY KEY,
    observed_at timestamptz NOT NULL DEFAULT now()
);
