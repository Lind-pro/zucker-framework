# Configuration storage

`ConfigService` reads and writes consumer-owned `config` records through `DATABASE_ADAPTER`.
The consumer registers its scopes with `ConfigScopeManager`; `ConfigPropertyDef.encrypted`
marks string values that require an explicit `ConfigEncryptor`. Keep encryption keys in the
consumer's secret environment or key service, separately from the configuration database.

Protected values fail closed without an encryptor, on non-string writes, or on decryption
failure. `get` / `getAll` are trusted server APIs and return decrypted values; HTTP controllers
must return a field allowlist and presence/source metadata instead of forwarding those results.

For protected properties, persisted history and change events contain `[REDACTED]` values.
Both event channels add `sensitive: true`; a trusted listener must reload through `get`, rather
than installing the event payload as a credential. `watch` also receives redacted values.
History is an audit of changes, not a credential backup: `rollback` rejects protected entries.
Replacing a secret must be an explicit authorized update through the consumer's settings flow.

History reads also mask protected rows written by older versions. This does not erase any
plaintext already stored by an older deployment; inspect and handle that deployment's historical
data under its own authorization and retention policy. The package never rotates live credentials
or rewrites existing history automatically.

Batch cache updates and notifications happen only after the database transaction succeeds.
The default history writer remains best effort and does not promise a mandatory transactional
audit trail. Consumers requiring a complete actor audit must persist it with their settings
transaction. These primitives do not by themselves reload provider instances or enable a UI.
