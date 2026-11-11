/**
 * Framework-neutral error for connection settings. `status` is the HTTP status an adapter should use
 * (400 invalid input, 409 revision conflict, 503 stored configuration unreadable or unassemblable).
 * Messages are fixed, generic strings: they never contain configuration values.
 */
export type ConnectionSettingsErrorStatus = 400 | 409 | 503;
export class ConnectionSettingsError extends Error {
  constructor(readonly status: ConnectionSettingsErrorStatus, message: string) {
    super(message);
    this.name = 'ConnectionSettingsError';
  }
}
export const STORED_CONNECTION_UNAVAILABLE = 'Saved connection configuration cannot be read; check the dedicated encryption key and stored configuration';
export function connectionStorageUnavailable(): ConnectionSettingsError {
  return new ConnectionSettingsError(503, STORED_CONNECTION_UNAVAILABLE);
}
export function invalidConnectionInput(message: string): ConnectionSettingsError {
  return new ConnectionSettingsError(400, message);
}
