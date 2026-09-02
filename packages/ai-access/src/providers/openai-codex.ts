import { readFile } from 'node:fs/promises';
import {
  credentialProfileId,
  type AIAccessProviderPlugin,
  type AIAccessRequest,
  type AIAccessResult,
  type AIAuthVerification,
  type CredentialProfile,
  type CredentialProfileStore,
} from '../contracts';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTH_BASE_URL = 'https://auth.openai.com';
const CODEX_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/oauth/token`;
const CODEX_DEVICE_CALLBACK_URL = `${CODEX_AUTH_BASE_URL}/deviceauth/callback`;
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DEVICE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_REFRESH_SKEW_MS = 120_000;
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

export interface CodexSubscriptionCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  updatedAt: number;
}

export type CodexSubscriptionAuthErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'LOGIN_RATE_LIMITED'
  | 'LOGIN_FAILED'
  | 'LOGIN_TIMEOUT'
  | 'REFRESH_RATE_LIMITED'
  | 'REFRESH_FAILED';

export class CodexSubscriptionAuthError extends Error {
  constructor(
    readonly code: CodexSubscriptionAuthErrorCode,
    message: string,
    readonly details: {
      status?: number;
      retryAfterMs?: number;
      reloginRequired?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause instanceof Error ? { cause: details.cause } : undefined);
    this.name = 'CodexSubscriptionAuthError';
  }

  get status(): number | undefined {
    return this.details.status;
  }

  get retryAfterMs(): number | undefined {
    return this.details.retryAfterMs;
  }

  get reloginRequired(): boolean {
    return this.details.reloginRequired ?? false;
  }
}

export class CodexCredentialProfileAdapter {
  readonly providerId = 'openai-codex';

  constructor(
    private readonly store: CredentialProfileStore,
    readonly profileName = 'default',
  ) {}

  async read(): Promise<CodexSubscriptionCredentials | null> {
    const profile = await this.store.get(this.providerId, this.profileName);
    if (!profile) return null;
    if (profile.credential.kind !== 'oauth') {
      throw new CodexSubscriptionAuthError(
        'INVALID_CREDENTIALS',
        'Codex 订阅 Profile 不是 OAuth 凭据。',
        { reloginRequired: true },
      );
    }
    return {
      accessToken: profile.credential.accessToken,
      refreshToken: profile.credential.refreshToken,
      expiresAt: profile.credential.expiresAt,
      accountId: String(profile.metadata.accountId ?? ''),
      updatedAt: profile.metadata.updatedAt,
    };
  }

  async write(credentials: CodexSubscriptionCredentials): Promise<void> {
    const existing = await this.store.get(this.providerId, this.profileName);
    const now = credentials.updatedAt;
    await this.store.save({
      id: credentialProfileId(this.providerId, this.profileName),
      providerId: this.providerId,
      profileName: this.profileName,
      authMethod: 'device-code',
      ownership: 'managed',
      credential: {
        kind: 'oauth',
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      },
      expiresAt: credentials.expiresAt,
      metadata: {
        ...existing?.metadata,
        accountId: credentials.accountId,
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
      },
    });
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.store.runExclusive(credentialProfileId(this.providerId, this.profileName), operation);
  }
}

export interface CodexSubscriptionCredentialManagerOptions {
  store: CredentialProfileStore;
  profileName?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  refreshSkewMs?: number;
  requestTimeoutMs?: number;
}

export class CodexSubscriptionCredentialManager {
  private readonly profile: CodexCredentialProfileAdapter;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly requestTimeoutMs: number;
  private refreshPromise: Promise<CodexSubscriptionCredentials> | null = null;

  constructor(options: CodexSubscriptionCredentialManagerOptions) {
    this.profile = new CodexCredentialProfileAdapter(options.store, options.profileName);
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getCredentials(options: {
    forceRefresh?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<CodexSubscriptionCredentials> {
    const stored = await this.profile.read();
    if (!stored) {
      throw new CodexSubscriptionAuthError(
        'NOT_AUTHENTICATED',
        'Codex 订阅尚未登录。',
        { reloginRequired: true },
      );
    }
    const credentials = normalizeCredentials(stored, this.now());
    if (!options.forceRefresh && credentials.expiresAt > this.now() + this.refreshSkewMs) {
      return credentials;
    }
    return this.refresh(options.forceRefresh ?? false, options.signal);
  }

  private async refresh(
    forceRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<CodexSubscriptionCredentials> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.profile
      .runExclusive(async () => {
        const stored = await this.profile.read();
        if (!stored) {
          throw new CodexSubscriptionAuthError(
            'NOT_AUTHENTICATED',
            'Codex 订阅凭据不存在。',
            { reloginRequired: true },
          );
        }
        const current = normalizeCredentials(stored, this.now());
        if (!forceRefresh && current.expiresAt > this.now() + this.refreshSkewMs) return current;
        const refreshed = await this.requestRefresh(current, signal);
        await this.profile.write(refreshed);
        return refreshed;
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async requestRefresh(
    credentials: CodexSubscriptionCredentials,
    signal?: AbortSignal,
  ): Promise<CodexSubscriptionCredentials> {
    let response: Response;
    try {
      response = await this.fetcher(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          originator: 'zucker-ai',
          'User-Agent': '@zucker/ai-access openai-codex',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
          client_id: CODEX_CLIENT_ID,
        }),
        signal: requestSignal(signal, this.requestTimeoutMs),
      });
    } catch (error) {
      throw new CodexSubscriptionAuthError('REFRESH_FAILED', 'Codex 订阅凭据刷新请求失败。', {
        cause: error,
      });
    }
    if (response.status === 429) {
      throw new CodexSubscriptionAuthError(
        'REFRESH_RATE_LIMITED',
        'Codex 订阅暂时达到用量或刷新限制。',
        { status: 429, retryAfterMs: retryAfterMs(response.headers, this.now()) },
      );
    }
    const payload = await readJson(response, 'REFRESH_FAILED');
    if (!response.ok) {
      const code = errorCode(payload);
      const reloginRequired =
        response.status === 401 ||
        response.status === 403 ||
        ['invalid_grant', 'invalid_token', 'refresh_token_reused'].includes(code ?? '');
      throw new CodexSubscriptionAuthError(
        'REFRESH_FAILED',
        reloginRequired ? 'Codex 订阅登录已失效，请重新登录。' : 'Codex 订阅凭据刷新失败。',
        { status: response.status, reloginRequired },
      );
    }
    return credentialsFromPayload(payload, this.now(), credentials.refreshToken);
  }
}

export interface CodexSubscriptionAuthClientOptions {
  store: CredentialProfileStore;
  profileName?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  deviceTimeoutMs?: number;
}

export class CodexSubscriptionAuthClient {
  private readonly profile: CodexCredentialProfileAdapter;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly deviceTimeoutMs: number;

  constructor(options: CodexSubscriptionAuthClientOptions) {
    this.profile = new CodexCredentialProfileAdapter(options.store, options.profileName);
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? delay;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deviceTimeoutMs = options.deviceTimeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS;
  }

  async loginWithDeviceCode(options: {
    onVerification: (verification: AIAuthVerification) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<CodexSubscriptionCredentials> {
    const device = await this.requestDeviceCode(options.signal);
    const expiresAt = this.now() + this.deviceTimeoutMs;
    await options.onVerification({
      verificationUrl: `${CODEX_AUTH_BASE_URL}/codex/device`,
      userCode: device.userCode,
      expiresAt,
    });
    const authorization = await this.poll(device, expiresAt, options.signal);
    const credentials = await this.exchange(authorization, options.signal);
    await this.profile.runExclusive(() => this.profile.write(credentials));
    return credentials;
  }

  private async requestDeviceCode(signal?: AbortSignal): Promise<{
    deviceAuthId: string;
    userCode: string;
    intervalMs: number;
  }> {
    const response = await this.request(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', originator: 'zucker-ai' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      signal,
    });
    if (response.status === 429) throw loginRateLimit(response, this.now());
    const payload = await readJson(response, 'LOGIN_FAILED');
    if (!response.ok) {
      throw new CodexSubscriptionAuthError('LOGIN_FAILED', '无法获取 Codex 设备登录码。', {
        status: response.status,
      });
    }
    const deviceAuthId = stringValue(payload, 'device_auth_id');
    const userCode = stringValue(payload, 'user_code') ?? stringValue(payload, 'usercode');
    if (!deviceAuthId || !userCode) {
      throw new CodexSubscriptionAuthError('LOGIN_FAILED', 'Codex 设备登录响应缺少必要字段。');
    }
    const interval = numberValue(payload, 'interval');
    return { deviceAuthId, userCode, intervalMs: Math.max(1_000, (interval ?? 5) * 1_000) };
  }

  private async poll(
    device: { deviceAuthId: string; userCode: string; intervalMs: number },
    expiresAt: number,
    signal?: AbortSignal,
  ): Promise<{ authorizationCode: string; codeVerifier: string }> {
    while (this.now() < expiresAt) {
      await this.sleep(device.intervalMs, signal);
      let response: Response;
      try {
        response = await this.request(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', originator: 'zucker-ai' },
          body: JSON.stringify({
            device_auth_id: device.deviceAuthId,
            user_code: device.userCode,
          }),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        continue;
      }
      if (response.status === 403 || response.status === 404) continue;
      if (response.status === 429) {
        await this.sleep(retryAfterMs(response.headers, this.now()) ?? device.intervalMs, signal);
        continue;
      }
      const payload = await readJson(response, 'LOGIN_FAILED');
      if (!response.ok) {
        throw new CodexSubscriptionAuthError('LOGIN_FAILED', 'Codex 设备登录确认失败。', {
          status: response.status,
        });
      }
      const authorizationCode = stringValue(payload, 'authorization_code');
      const codeVerifier = stringValue(payload, 'code_verifier');
      if (!authorizationCode || !codeVerifier) {
        throw new CodexSubscriptionAuthError('LOGIN_FAILED', 'Codex 设备登录确认缺少必要字段。');
      }
      return { authorizationCode, codeVerifier };
    }
    throw new CodexSubscriptionAuthError('LOGIN_TIMEOUT', 'Codex 设备登录已超时。');
  }

  private async exchange(
    authorization: { authorizationCode: string; codeVerifier: string },
    signal?: AbortSignal,
  ): Promise<CodexSubscriptionCredentials> {
    const response = await this.request(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        originator: 'zucker-ai',
        'User-Agent': '@zucker/ai-access openai-codex',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorization.authorizationCode,
        redirect_uri: CODEX_DEVICE_CALLBACK_URL,
        client_id: CODEX_CLIENT_ID,
        code_verifier: authorization.codeVerifier,
      }),
      signal,
    });
    if (response.status === 429) throw loginRateLimit(response, this.now());
    const payload = await readJson(response, 'LOGIN_FAILED');
    if (!response.ok) {
      throw new CodexSubscriptionAuthError('LOGIN_FAILED', 'Codex 设备登录令牌交换失败。', {
        status: response.status,
      });
    }
    return credentialsFromPayload(payload, this.now());
  }

  private async request(
    url: string,
    init: Omit<RequestInit, 'signal'> & { signal?: AbortSignal },
  ): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init,
        signal: requestSignal(init.signal, this.requestTimeoutMs),
      });
    } catch (error) {
      throw new CodexSubscriptionAuthError('LOGIN_FAILED', 'Codex 设备登录请求失败。', {
        cause: error,
      });
    }
  }
}

interface OpenAIResponsesClient {
  responses: {
    create(
      request: Record<string, unknown>,
      options?: { signal?: AbortSignal; headers?: Record<string, string> },
    ): Promise<unknown>;
  };
}

export interface OpenAICodexSubscriptionProviderOptions {
  store: CredentialProfileStore;
  profileName?: string;
  fetcher?: typeof fetch;
  originator?: string;
  userAgent?: string;
}

export class OpenAICodexSubscriptionProvider {
  readonly id = 'openai-codex';
  readonly name = 'OpenAI Codex Subscription';
  private readonly manager: CodexSubscriptionCredentialManager;
  private readonly fetcher: typeof fetch;
  private readonly originator: string;
  private readonly userAgent: string;

  constructor(options: OpenAICodexSubscriptionProviderOptions) {
    this.manager = new CodexSubscriptionCredentialManager({
      store: options.store,
      profileName: options.profileName,
      fetcher: options.fetcher,
    });
    this.fetcher = options.fetcher ?? fetch;
    this.originator = options.originator?.trim() || 'zucker-ai';
    this.userAgent = options.userAgent?.trim() || '@zucker/ai-access openai-codex';
  }

  async createModel(config: {
    apiKey?: string;
    modelId: string;
    baseURL?: string;
    timeoutMs?: number;
  }): Promise<OpenAICodexSubscriptionClient> {
    validateBaseUrl(config.baseURL);
    await this.manager.getCredentials();
    let module: Record<string, unknown>;
    try {
      const packageName = 'openai';
      module = (await import(/* @vite-ignore */ packageName)) as Record<string, unknown>;
    } catch {
      throw new Error('openai package not installed. Run: npm install openai');
    }
    const OpenAI = (module.default ?? module.OpenAI) as new (
      options: Record<string, unknown>,
    ) => OpenAIResponsesClient;
    const client = new OpenAI({
      apiKey: async () => (await this.manager.getCredentials()).accessToken,
      baseURL: CODEX_BASE_URL,
      timeout: config.timeoutMs,
      maxRetries: 0,
      defaultHeaders: {
        originator: this.originator,
        'User-Agent': this.userAgent,
        'OpenAI-Beta': 'responses=experimental',
      },
      fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const credentials = await this.manager.getCredentials();
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        headers.set('chatgpt-account-id', credentials.accountId);
        return this.fetcher(input, { ...init, headers });
      },
    });
    return new OpenAICodexSubscriptionClient(client, config.modelId);
  }
}

export class OpenAICodexSubscriptionClient {
  constructor(
    private readonly client: OpenAIResponsesClient,
    private readonly defaultModel: string,
  ) {}

  async complete(request: Omit<AIAccessRequest, 'model'> & { model?: string }): Promise<AIAccessResult> {
    const headers = request.sessionId
      ? { session_id: request.sessionId, 'x-client-request-id': request.sessionId }
      : undefined;
    const stream = await this.client.responses.create(
      {
        model: request.model ?? this.defaultModel,
        instructions: request.instructions?.trim() || '你是一个专业、准确的AI助手。',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: request.input }] },
        ],
        store: false,
        stream: true,
        text: { verbosity: request.textVerbosity ?? 'low' },
        reasoning: request.reasoningEffort
          ? { effort: request.reasoningEffort, summary: 'auto' }
          : undefined,
      },
      { signal: request.signal, headers },
    );
    if (!isAsyncIterable(stream)) return responseResult(stream);
    let content = '';
    let completed: Record<string, unknown> = {};
    for await (const event of stream) {
      if (!isRecord(event)) continue;
      const type = stringValue(event, 'type');
      if (type === 'response.output_text.delta') content += rawStringValue(event, 'delta') ?? '';
      else if (type === 'response.completed' && isRecord(event.response)) completed = event.response;
      else if (type === 'response.failed' || type === 'error') throw responseError(event);
    }
    const result = responseResult(completed);
    return { ...result, content: content || result.content };
  }
}

export const createOpenAICodexAccessProvider = (): AIAccessProviderPlugin => ({
  id: 'openai-codex',
  name: 'OpenAI Codex Subscription',
  authMethods: [
    {
      id: 'device-code',
      label: 'OpenAI Codex device code',
      kind: 'device-code',
      login: async (context) => {
        const auth = new CodexSubscriptionAuthClient({
          store: context.store,
          profileName: context.profileName,
        });
        await auth.loginWithDeviceCode({
          signal: context.signal,
          onVerification: async (verification) => {
            if (!context.onVerification) {
              throw new Error('设备码登录需要 onVerification 回调。');
            }
            await context.onVerification(verification);
          },
        });
        const profile = await context.store.get('openai-codex', context.profileName);
        if (!profile) throw new Error('Codex 登录完成但 Profile 未保存。');
        return profile;
      },
    },
  ],
  credentialSources: [
    {
      id: 'legacy-file',
      label: '旧版 Codex 凭据文件',
      kind: 'file',
      ownership: 'managed',
      discover: async (context) => {
        if (!context.location) throw new Error('导入 Codex 凭据时必须提供文件路径。');
        return [await readLegacyCodexSubscriptionProfile(context.location, context.profileName)];
      },
    },
  ],
  runtime: {
    complete: async (request, context) => {
      const provider = new OpenAICodexSubscriptionProvider({
        store: context.store,
        profileName: context.profileName,
      });
      const client = await provider.createModel({ modelId: request.model });
      return client.complete(request);
    },
  },
});

export async function readLegacyCodexSubscriptionProfile(
  filePath: string,
  profileName = 'default',
): Promise<CredentialProfile> {
  const payload = JSON.parse(await readFile(filePath, 'utf8')) as {
    version?: unknown;
    credentials?: Partial<CodexSubscriptionCredentials>;
  };
  const credentials = payload.credentials;
  if (
    payload.version !== 1 ||
    !credentials ||
    typeof credentials.accessToken !== 'string' ||
    typeof credentials.refreshToken !== 'string' ||
    typeof credentials.expiresAt !== 'number' ||
    typeof credentials.accountId !== 'string' ||
    typeof credentials.updatedAt !== 'number'
  ) {
    throw new Error('旧版 Codex 订阅凭据文件格式无效。');
  }
  return profileFromCredentials(
    {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      accountId: credentials.accountId,
      updatedAt: credentials.updatedAt,
    },
    profileName,
  );
}

function profileFromCredentials(
  credentials: CodexSubscriptionCredentials,
  profileName: string,
): CredentialProfile {
  return {
    id: credentialProfileId('openai-codex', profileName),
    providerId: 'openai-codex',
    profileName,
    authMethod: 'device-code',
    ownership: 'managed',
    credential: {
      kind: 'oauth',
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
    },
    expiresAt: credentials.expiresAt,
    metadata: {
      accountId: credentials.accountId,
      createdAt: credentials.updatedAt,
      updatedAt: credentials.updatedAt,
    },
  };
}

function normalizeCredentials(
  credentials: CodexSubscriptionCredentials,
  now: number,
): CodexSubscriptionCredentials {
  const accessToken = credentials.accessToken.trim();
  const refreshToken = credentials.refreshToken.trim();
  const claims = decodeJwt(accessToken);
  const accountId =
    credentials.accountId.trim() || nestedString(claims, OPENAI_AUTH_CLAIM, 'chatgpt_account_id');
  const tokenExpiry = numberValue(claims, 'exp');
  const expiresAt = credentials.expiresAt > 0
    ? credentials.expiresAt
    : tokenExpiry
      ? tokenExpiry * 1_000
      : now;
  if (!accessToken || !refreshToken || !accountId) {
    throw new CodexSubscriptionAuthError(
      'INVALID_CREDENTIALS',
      'Codex 订阅凭据不完整。',
      { reloginRequired: true },
    );
  }
  return { ...credentials, accessToken, refreshToken, accountId, expiresAt };
}

function credentialsFromPayload(
  payload: Record<string, unknown>,
  now: number,
  fallbackRefreshToken?: string,
): CodexSubscriptionCredentials {
  const accessToken = stringValue(payload, 'access_token');
  const refreshToken = stringValue(payload, 'refresh_token') ?? fallbackRefreshToken;
  if (!accessToken || !refreshToken) {
    throw new CodexSubscriptionAuthError('INVALID_CREDENTIALS', 'Codex 登录响应缺少 Token。', {
      reloginRequired: true,
    });
  }
  const claims = decodeJwt(accessToken);
  const accountId = nestedString(claims, OPENAI_AUTH_CLAIM, 'chatgpt_account_id');
  if (!accountId) {
    throw new CodexSubscriptionAuthError('INVALID_CREDENTIALS', 'Codex Token 缺少账户标识。', {
      reloginRequired: true,
    });
  }
  const expiresIn = numberValue(payload, 'expires_in');
  const tokenExpiry = numberValue(claims, 'exp');
  const expiresAt = expiresIn ? now + expiresIn * 1_000 : tokenExpiry ? tokenExpiry * 1_000 : now + 3_600_000;
  return { accessToken, refreshToken, accountId, expiresAt, updatedAt: now };
}

function validateBaseUrl(baseUrl?: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl?.trim() || CODEX_BASE_URL);
  } catch {
    throw new Error('Codex 订阅端点不是有效 URL。');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'chatgpt.com' ||
    (url.port && url.port !== '443') ||
    url.pathname.replace(/\/+$/u, '') !== '/backend-api/codex' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Codex 订阅凭据只允许发送到 OpenAI 官方 ChatGPT Codex HTTPS 端点。');
  }
}

async function readJson(
  response: Response,
  code: 'LOGIN_FAILED' | 'REFRESH_FAILED',
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch (error) {
    throw new CodexSubscriptionAuthError(code, 'Codex 认证响应不是有效 JSON。', {
      status: response.status,
      cause: error,
    });
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function retryAfterMs(headers: Headers, now: number): number | undefined {
  const milliseconds = headers.get('retry-after-ms');
  if (milliseconds && Number.isFinite(Number(milliseconds))) return Math.max(0, Number(milliseconds));
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function loginRateLimit(response: Response, now: number): CodexSubscriptionAuthError {
  return new CodexSubscriptionAuthError(
    'LOGIN_RATE_LIMITED',
    'OpenAI 暂时限制 Codex 登录请求。',
    { status: 429, retryAfterMs: retryAfterMs(response.headers, now) },
  );
}

function errorCode(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (typeof error === 'string') return error;
  return isRecord(error) ? stringValue(error, 'code') ?? stringValue(error, 'type') : undefined;
}

function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function responseResult(value: unknown): AIAccessResult {
  const response = isRecord(value) ? value : {};
  const usage = isRecord(response.usage) ? response.usage : {};
  const input = numberValue(usage, 'input_tokens') ?? 0;
  const output = numberValue(usage, 'output_tokens') ?? 0;
  return {
    content: rawStringValue(response, 'output_text') ?? outputText(response.output),
    finishReason: stringValue(response, 'status') ?? 'completed',
    responseId: stringValue(response, 'id'),
    tokenUsage: { input, output, total: numberValue(usage, 'total_tokens') ?? input + output },
  };
}

function outputText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && stringValue(content, 'type') === 'output_text') {
        const text = rawStringValue(content, 'text');
        if (text !== undefined) parts.push(text);
      }
    }
  }
  return parts.join('');
}

function responseError(event: Record<string, unknown>): Error {
  const response = isRecord(event.response) ? event.response : event;
  const error = isRecord(response.error) ? response.error : response;
  const failure = new Error(stringValue(error, 'message') ?? 'Codex Responses 请求失败。') as Error & {
    status?: number;
    code?: string;
  };
  failure.status = numberValue(error, 'status') ?? numberValue(response, 'status_code');
  failure.code = stringValue(error, 'code') ?? stringValue(error, 'type');
  return failure;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function rawStringValue(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function numberValue(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === 'string' && candidate.trim() && Number.isFinite(Number(candidate))) {
    return Number(candidate);
  }
  return undefined;
}

function nestedString(value: Record<string, unknown>, parent: string, key: string): string {
  const record = value[parent];
  return isRecord(record) ? stringValue(record, key) ?? '' : '';
}
