import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConnectionSettingsError } from '@zucker-framework/config/connections';

/** Maps the framework-neutral `ConnectionSettingsError` to the Nest exception with the same status and fixed message. */
export function toHttpError(error: unknown): unknown {
  if (!(error instanceof ConnectionSettingsError)) return error;
  if (error.status === 400) return new BadRequestException(error.message);
  if (error.status === 409) return new ConflictException(error.message);
  return new ServiceUnavailableException(error.message);
}
export function withHttpErrors<T>(work: () => T): T {
  try { return work(); } catch (error) { throw toHttpError(error); }
}
export async function withHttpErrorsAsync<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw toHttpError(error); }
}
