export type CredentialOwnership = 'managed' | 'external-readonly';

export interface OAuthCredentialMaterial {
  kind: 'oauth';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface ApiKeyCredentialMaterial {
  kind: 'api-key';
  apiKey: string;
}

export interface StaticTokenCredentialMaterial {
  kind: 'token';
  token: string;
  expiresAt?: number;
}

export interface ExternalCredentialReference {
  kind: 'external-reference';
  source: string;
  reference: string;
}

export type CredentialMaterial =
  | OAuthCredentialMaterial
  | ApiKeyCredentialMaterial
  | StaticTokenCredentialMaterial
  | ExternalCredentialReference;

export interface CredentialProfileMetadata {
  accountId?: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  [key: string]: string | number | boolean | undefined;
}

export interface CredentialProfile {
  id: string;
  providerId: string;
  profileName: string;
  authMethod: string;
  ownership: CredentialOwnership;
  credential: CredentialMaterial;
  expiresAt?: number;
  metadata: CredentialProfileMetadata;
}

export interface CredentialProfileStore {
  ensureSchema?(): Promise<void>;
  get(providerId: string, profileName?: string): Promise<CredentialProfile | null>;
  list(providerId?: string): Promise<CredentialProfile[]>;
  save(profile: CredentialProfile): Promise<void>;
  remove(providerId: string, profileName?: string): Promise<boolean>;
  runExclusive<T>(profileId: string, operation: () => Promise<T>): Promise<T>;
}

export type AIAuthKind = 'device-code' | 'pkce' | 'setup-token' | 'api-key' | 'custom';

export interface AIAuthVerification {
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
}

export interface AIAuthContext {
  store: CredentialProfileStore;
  profileName: string;
  signal?: AbortSignal;
  onVerification?: (verification: AIAuthVerification) => void | Promise<void>;
}

export interface AIAuthMethod {
  id: string;
  label: string;
  kind: AIAuthKind;
  login(context: AIAuthContext): Promise<CredentialProfile>;
}

export type AICredentialSourceKind = 'file' | 'environment' | 'database' | 'api' | 'custom';

export interface AICredentialSourceContext {
  profileName: string;
  location?: string;
}

export interface AICredentialSource {
  id: string;
  label: string;
  kind: AICredentialSourceKind;
  ownership: CredentialOwnership;
  discover(context: AICredentialSourceContext): Promise<CredentialProfile[]>;
}

export interface AIAccessRequest {
  model: string;
  input: string;
  instructions?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  textVerbosity?: 'low' | 'medium' | 'high';
  outputSchema?: unknown;
  /** Explicit opt-in to one native generated image (Codex CLI/app-server). */
  imageGeneration?: boolean;
  sessionId?: string;
  signal?: AbortSignal;
  /** Ordered answer deltas, excluding reasoning. Awaited; failures stop the attempt. */
  onTextDelta?: (delta: string) => void | Promise<void>;
}

export interface AIAccessResult {
  images?: Array<{ data: string; mimeType: "image/png"; revisedPrompt?: string }>;
  content: string;
  finishReason: string;
  responseId?: string;
  /** Model reported by the provider, when it differs from or resolves the requested alias. */
  model?: string;
  tokenUsage: {
    /** All prompt tokens processed, including cached ones. */
    input: number;
    output: number;
    total: number;
    /** Portion of `input` served from the provider prompt cache, when reported. */
    cacheReadInput?: number;
    /** Portion of `input` written to the provider prompt cache, when reported. */
    cacheCreationInput?: number;
  };
}

export interface AIRuntimeContext {
  store: CredentialProfileStore;
  profileName: string;
}

export interface AIRuntimeDriver {
  complete(request: AIAccessRequest, context: AIRuntimeContext): Promise<AIAccessResult>;
}

export interface AIAccessProviderPlugin {
  id: string;
  name: string;
  authMethods: AIAuthMethod[];
  credentialSources: AICredentialSource[];
  runtime: AIRuntimeDriver;
}

export const credentialProfileId = (providerId: string, profileName = 'default'): string =>
  `${providerId}:${profileName}`;
