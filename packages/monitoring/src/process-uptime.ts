export interface ProcessUptimeSnapshot {
  uptimeMs: number;
  uptimeSeconds: number;
}

/** Return a non-negative process duration with explicit units. */
export function getProcessUptime(startedAtMs: number, nowMs = Date.now()): ProcessUptimeSnapshot {
  const uptimeMs = Math.max(0, nowMs - startedAtMs);
  return {
    uptimeMs,
    uptimeSeconds: Math.floor(uptimeMs / 1_000),
  };
}
