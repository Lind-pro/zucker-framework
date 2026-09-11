# Temporary export artifacts

`TemporaryExportJobs<C>` manages process-local export records, duplicate active requests, temporary file writes/downloads, expiry and cleanup. Configure the working directory, TTL, cleanup interval, deduplication key and asynchronous artifact builder. The caller must authorize the context before start/get/download and supplies all output names, formats, progress messages and errors.

It provides no persistence across process replacement. Do not use it as a durable task store. Expiry during rendering removes the resulting file instead of leaving an orphan. Call onModuleDestroy when the owning application service shuts down.
