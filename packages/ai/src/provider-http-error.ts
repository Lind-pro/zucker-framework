/**
 * HTTP failure from a media provider's REST API. Carries `status` so
 * `classifyAIError` can tell client errors (not retried) from server errors.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider} API ${status}: ${detail}`);
    this.name = 'ProviderHttpError';
  }
}

/** Builds a {@link ProviderHttpError} from a failed fetch response, keeping the body bounded. */
export async function providerHttpError(provider: string, response: Response): Promise<ProviderHttpError> {
  const body = await response.text().catch(() => '');
  const detail = (body || response.statusText || '').slice(0, 1_000);
  return new ProviderHttpError(provider, response.status, detail);
}
