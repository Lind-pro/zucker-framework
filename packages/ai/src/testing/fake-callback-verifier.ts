import type {
  AIProviderCallbackHeaders,
  AIProviderCallbackVerification,
  AIProviderCallbackVerifier,
} from '../ai-provider-callback';

export interface FakeCallbackVerifierOptions {
  /** Default `fake-media`. */
  providerId?: string;
  /** Header that must carry `token`. Default `x-fake-signature`. */
  header?: string;
  /** Accepted header value. Default `valid`. */
  token?: string;
}

/**
 * Test verifier: a callback is authentic when header `x-fake-signature` equals the token and the
 * JSON body has a string `taskId`. Anything else returns `null` (never throws), which lets
 * consumers test the "unverified callback is only a wake-up hint" path. It never returns `task`,
 * so a verified callback still requires a poll.
 */
export class FakeCallbackVerifier implements AIProviderCallbackVerifier {
  readonly providerId: string;
  readonly calls: Array<{ rawBody: string; accepted: boolean }> = [];
  private readonly header: string;
  private readonly token: string;

  constructor(options: FakeCallbackVerifierOptions = {}) {
    this.providerId = options.providerId ?? 'fake-media';
    this.header = (options.header ?? 'x-fake-signature').toLowerCase();
    this.token = options.token ?? 'valid';
  }

  async verify(rawBody: Uint8Array | string, headers: AIProviderCallbackHeaders): Promise<AIProviderCallbackVerification | null> {
    const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
    const value = Object.entries(headers).find(([name]) => name.toLowerCase() === this.header)?.[1];
    let taskId: unknown;
    try {
      taskId = (JSON.parse(text) as { taskId?: unknown })?.taskId;
    } catch {
      taskId = undefined;
    }
    const accepted = value === this.token && typeof taskId === 'string' && taskId.length > 0;
    this.calls.push({ rawBody: text, accepted });
    return accepted ? { providerTaskId: taskId as string } : null;
  }

  /** Unauthenticated task id claim (JSON body `taskId`), for the early-poll path. */
  hint(rawBody: Uint8Array | string): string | null {
    try {
      const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
      const taskId = (JSON.parse(text) as { taskId?: unknown })?.taskId;
      return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 256 ? taskId : null;
    } catch {
      return null;
    }
  }
}
