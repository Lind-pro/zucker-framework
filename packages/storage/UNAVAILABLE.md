# Explicitly unavailable storage

`UnavailableFileManager(providerType, message?)` implements the existing `FileManager` contract for a configured application whose storage credentials are absent or intentionally disabled. It creates no client and has no lifecycle hooks. `isConfigured` is false, `exists` resolves false, `list` resolves an empty array, and upload/download/delete/URL operations reject using the configured message.

Consumers retain environment selection and localized configuration messages. Register the selected manager once under `FILE_MANAGER`; consumers inject this token with the `FileManager` type instead of a forwarding service. This does not change active S3/WebDAV configuration, object paths or URL policy. Behavior tests were added but not run in this source-only migration.
