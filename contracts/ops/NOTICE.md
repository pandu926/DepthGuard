# Validator seccomp provenance

`validator-seccomp.json` is derived from Moby's default profile at the revision and hash
in `seccomp-provenance.json`. Moby's Apache 2.0 license is included as `LICENSE.moby`.
Only `io_uring_setup`, `io_uring_enter` and `io_uring_register` are added for the trusted
local Agave 4 validator. This exception does not apply to the API, worker or PostgreSQL.
