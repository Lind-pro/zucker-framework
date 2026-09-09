# @zucker-framework/ext-kit

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Replace downstream product names in extension CLI help, API comments, schema
  examples and test fixtures with neutral examples. Consumer-supplied identifiers
  and storage-key behavior are unchanged. The extension template uses reserved
  example domains for licensing and purchase links until the consumer configures
  its own endpoints.
- Disable source maps in package builds. Release checks now reject source maps,
  inline source map references and uncompiled TypeScript/JSX implementation files
  while retaining public type declarations and required runtime assets.
