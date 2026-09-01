export interface ProcessUptimeSnapshot {
  uptimeMs: number;
  uptimeSeconds: number;
}

/**
 * Return process uptime with explicit units for health APIs and diagnostics.
 */
export function getProcessUptime(startedAtMs: number, nowMs = Date.now()): ProcessUptimeSnapshot {
  const uptimeMs = Math.max(0, nowMs - startedAtMs);
  return {
    uptimeMs,
    uptimeSeconds: Math.floor(uptimeMs / 1000),
  };
}
