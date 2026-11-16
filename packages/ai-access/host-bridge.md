# Codex CLI host bridge

`startCodexCliHost` and `runCodexCliHostClient` implement both ends of a Unix socket NDJSON transport for the existing Codex CLI provider's executable bridge. They preserve stdout, stderr and the process exit code independently; this transport does not interpret or fulfill application results.

The host receives its socket, executable, Codex Home, scratch root, timeout and environment explicitly. It accepts only prompt/model/reasoning/verbosity/schema fields, creates one private scratch directory per request, writes the optional schema with mode 0600 and rebuilds the restricted CLI arguments itself. The fixed sandbox permits reading only minimal system files (the scratch directory itself is denied; Codex reads the schema in its own process), with no write, network tools, project instructions (AGENTS.md), hooks, apps, plugins, memories, shell tools or inherited rules/configuration. Application data and credentials do not enter the scratch directory. Environment forwarding uses an allowlist, and the socket is mode 0600.

The client converts supported CLI arguments into the host protocol, sends schema contents rather than a cross-host file path, and reports the final exit code. Cancellation disconnects the socket; the host terminates the corresponding process group and removes scratch files. Consumer CLI wrappers own process stdin/stdout, signal registration, environment variable names, default paths and service startup.

Local spawn mode, app-server mode and host mode share the same Codex configuration overrides, so the sandbox cannot drift between them. No consumer executable or arbitrary command flags are forwarded to the host.

Ship the client wrapper together with the same fixed, released ai-access package on the host. A container may read that installed directory through its existing read-only mount. Source changes and the focused host/client test sources require validation before an immutable package release and any deployment; the module never installs packages or starts a production service itself.
