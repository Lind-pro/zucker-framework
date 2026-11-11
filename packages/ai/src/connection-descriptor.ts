/**
 * Plain-data connection descriptors for the native AI provider connections: profile id, environment keys, field types,
 * English display text and stable translation keys. It has no runtime dependency; an application turns
 * it into a saved connection profile with `localizeConnectionDescriptor` from
 * `@zucker-framework/config/connections` (matched structurally) and adds its own validation.
 * Ids and environment keys are a storage contract: saved configuration is keyed by them, so never rename one.
 */
export type AIConnectionFieldType = 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
export interface AIConnectionDescriptorField {
  readonly key: string; readonly label: string; readonly labelKey: string; readonly type: AIConnectionFieldType;
  readonly options?: readonly string[]; readonly defaultValue?: string; readonly description?: string; readonly min?: number; readonly max?: number;
}
export interface AIConnectionDescriptor {
  readonly profile: {
    readonly id: string; readonly name: string; readonly labelKey: string; readonly category: string; readonly categoryKey: string;
    readonly fields: readonly AIConnectionDescriptorField[];
  };
}

export const OPENAI_AI_CONNECTION_DESCRIPTOR: AIConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'ai-openai', name: 'OpenAI', labelKey: 'connections.ai-openai', category: 'AI', categoryKey: 'connections.category.ai',
    fields: Object.freeze<AIConnectionDescriptorField[]>([
      { key: 'AI_OPENAI_ENABLED', label: 'Enabled', labelKey: 'connections.field.AI_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'AI_OPENAI_API_KEY', label: 'API key', labelKey: 'connections.field.AI_API_KEY', type: 'secret' },
      { key: 'AI_OPENAI_MODEL_ID', label: 'Model ID', labelKey: 'connections.field.AI_MODEL_ID', type: 'text' },
      { key: 'AI_OPENAI_BASE_URL', label: 'API base URL', labelKey: 'connections.field.AI_BASE_URL', type: 'url', defaultValue: 'https://api.openai.com/v1', description: 'HTTPS URL without user name, query or fragment; required for compatible APIs.' },
      { key: 'AI_OPENAI_MAX_TOKENS', label: 'Maximum output tokens', labelKey: 'connections.field.AI_MAX_TOKENS', type: 'number', min: 1, max: 1048576, description: 'Required for Anthropic; other connections may set it per call. The model limits still apply.' },
      { key: 'AI_OPENAI_TIMEOUT_MS', label: 'Timeout (ms)', labelKey: 'connections.field.AI_TIMEOUT_MS', type: 'number', defaultValue: '60000', min: 1, max: 600000 },
    ]) }),
});
export const COMPATIBLE_AI_CONNECTION_DESCRIPTOR: AIConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'ai-compatible', name: 'OpenAI-compatible API', labelKey: 'connections.ai-compatible', category: 'AI', categoryKey: 'connections.category.ai',
    fields: Object.freeze<AIConnectionDescriptorField[]>([
      { key: 'AI_COMPATIBLE_ENABLED', label: 'Enabled', labelKey: 'connections.field.AI_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'AI_COMPATIBLE_API_KEY', label: 'API key', labelKey: 'connections.field.AI_API_KEY', type: 'secret' },
      { key: 'AI_COMPATIBLE_MODEL_ID', label: 'Model ID', labelKey: 'connections.field.AI_MODEL_ID', type: 'text' },
      { key: 'AI_COMPATIBLE_BASE_URL', label: 'API base URL', labelKey: 'connections.field.AI_BASE_URL', type: 'url', description: 'HTTPS URL without user name, query or fragment; required for compatible APIs.' },
      { key: 'AI_COMPATIBLE_MAX_TOKENS', label: 'Maximum output tokens', labelKey: 'connections.field.AI_MAX_TOKENS', type: 'number', min: 1, max: 1048576, description: 'Required for Anthropic; other connections may set it per call. The model limits still apply.' },
      { key: 'AI_COMPATIBLE_TIMEOUT_MS', label: 'Timeout (ms)', labelKey: 'connections.field.AI_TIMEOUT_MS', type: 'number', defaultValue: '60000', min: 1, max: 600000 },
    ]) }),
});
export const OPENROUTER_AI_CONNECTION_DESCRIPTOR: AIConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'ai-openrouter', name: 'OpenRouter', labelKey: 'connections.ai-openrouter', category: 'AI', categoryKey: 'connections.category.ai',
    fields: Object.freeze<AIConnectionDescriptorField[]>([
      { key: 'AI_OPENROUTER_ENABLED', label: 'Enabled', labelKey: 'connections.field.AI_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'AI_OPENROUTER_API_KEY', label: 'API key', labelKey: 'connections.field.AI_API_KEY', type: 'secret' },
      { key: 'AI_OPENROUTER_MODEL_ID', label: 'Model ID', labelKey: 'connections.field.AI_MODEL_ID', type: 'text' },
      { key: 'AI_OPENROUTER_BASE_URL', label: 'API base URL', labelKey: 'connections.field.AI_BASE_URL', type: 'url', defaultValue: 'https://openrouter.ai/api/v1', description: 'HTTPS URL without user name, query or fragment; required for compatible APIs.' },
      { key: 'AI_OPENROUTER_MAX_TOKENS', label: 'Maximum output tokens', labelKey: 'connections.field.AI_MAX_TOKENS', type: 'number', min: 1, max: 1048576, description: 'Required for Anthropic; other connections may set it per call. The model limits still apply.' },
      { key: 'AI_OPENROUTER_TIMEOUT_MS', label: 'Timeout (ms)', labelKey: 'connections.field.AI_TIMEOUT_MS', type: 'number', defaultValue: '60000', min: 1, max: 600000 },
    ]) }),
});
export const DEEPSEEK_AI_CONNECTION_DESCRIPTOR: AIConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'ai-deepseek', name: 'DeepSeek', labelKey: 'connections.ai-deepseek', category: 'AI', categoryKey: 'connections.category.ai',
    fields: Object.freeze<AIConnectionDescriptorField[]>([
      { key: 'AI_DEEPSEEK_ENABLED', label: 'Enabled', labelKey: 'connections.field.AI_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'AI_DEEPSEEK_API_KEY', label: 'API key', labelKey: 'connections.field.AI_API_KEY', type: 'secret' },
      { key: 'AI_DEEPSEEK_MODEL_ID', label: 'Model ID', labelKey: 'connections.field.AI_MODEL_ID', type: 'text' },
      { key: 'AI_DEEPSEEK_BASE_URL', label: 'API base URL', labelKey: 'connections.field.AI_BASE_URL', type: 'url', defaultValue: 'https://api.deepseek.com/v1', description: 'HTTPS URL without user name, query or fragment; required for compatible APIs.' },
      { key: 'AI_DEEPSEEK_MAX_TOKENS', label: 'Maximum output tokens', labelKey: 'connections.field.AI_MAX_TOKENS', type: 'number', min: 1, max: 1048576, description: 'Required for Anthropic; other connections may set it per call. The model limits still apply.' },
      { key: 'AI_DEEPSEEK_TIMEOUT_MS', label: 'Timeout (ms)', labelKey: 'connections.field.AI_TIMEOUT_MS', type: 'number', defaultValue: '60000', min: 1, max: 600000 },
    ]) }),
});
export const ANTHROPIC_AI_CONNECTION_DESCRIPTOR: AIConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'ai-anthropic', name: 'Anthropic', labelKey: 'connections.ai-anthropic', category: 'AI', categoryKey: 'connections.category.ai',
    fields: Object.freeze<AIConnectionDescriptorField[]>([
      { key: 'AI_ANTHROPIC_ENABLED', label: 'Enabled', labelKey: 'connections.field.AI_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'AI_ANTHROPIC_API_KEY', label: 'API key', labelKey: 'connections.field.AI_API_KEY', type: 'secret' },
      { key: 'AI_ANTHROPIC_MODEL_ID', label: 'Model ID', labelKey: 'connections.field.AI_MODEL_ID', type: 'text' },
      { key: 'AI_ANTHROPIC_BASE_URL', label: 'API base URL', labelKey: 'connections.field.AI_BASE_URL', type: 'url', defaultValue: 'https://api.anthropic.com', description: 'HTTPS URL without user name, query or fragment; required for compatible APIs.' },
      { key: 'AI_ANTHROPIC_MAX_TOKENS', label: 'Maximum output tokens', labelKey: 'connections.field.AI_MAX_TOKENS', type: 'number', min: 1, max: 1048576, description: 'Required for Anthropic; other connections may set it per call. The model limits still apply.' },
      { key: 'AI_ANTHROPIC_TIMEOUT_MS', label: 'Timeout (ms)', labelKey: 'connections.field.AI_TIMEOUT_MS', type: 'number', defaultValue: '60000', min: 1, max: 600000 },
    ]) }),
});
export const GEMINI_AI_CONNECTION_DESCRIPTOR: AIConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'ai-gemini', name: 'Gemini (GenAI)', labelKey: 'connections.ai-gemini', category: 'AI', categoryKey: 'connections.category.ai',
    fields: Object.freeze<AIConnectionDescriptorField[]>([
      { key: 'AI_GEMINI_ENABLED', label: 'Enabled', labelKey: 'connections.field.AI_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'AI_GEMINI_API_KEY', label: 'API key', labelKey: 'connections.field.AI_API_KEY', type: 'secret' },
      { key: 'AI_GEMINI_MODEL_ID', label: 'Model ID', labelKey: 'connections.field.AI_MODEL_ID', type: 'text' },
      { key: 'AI_GEMINI_BASE_URL', label: 'API base URL', labelKey: 'connections.field.AI_BASE_URL', type: 'url', defaultValue: 'https://generativelanguage.googleapis.com', description: 'HTTPS URL without user name, query or fragment; required for compatible APIs.' },
      { key: 'AI_GEMINI_MAX_TOKENS', label: 'Maximum output tokens', labelKey: 'connections.field.AI_MAX_TOKENS', type: 'number', min: 1, max: 1048576, description: 'Required for Anthropic; other connections may set it per call. The model limits still apply.' },
      { key: 'AI_GEMINI_TIMEOUT_MS', label: 'Timeout (ms)', labelKey: 'connections.field.AI_TIMEOUT_MS', type: 'number', defaultValue: '60000', min: 1, max: 600000 },
    ]) }),
});
/** Native AI connections in admin display order; field keys are `<prefix>_ENABLED`, `_API_KEY`, `_MODEL_ID`, `_BASE_URL`, `_MAX_TOKENS`, `_TIMEOUT_MS`. */
export const AI_CONNECTION_DESCRIPTORS: readonly AIConnectionDescriptor[] = Object.freeze([OPENAI_AI_CONNECTION_DESCRIPTOR, COMPATIBLE_AI_CONNECTION_DESCRIPTOR, OPENROUTER_AI_CONNECTION_DESCRIPTOR, DEEPSEEK_AI_CONNECTION_DESCRIPTOR, ANTHROPIC_AI_CONNECTION_DESCRIPTOR, GEMINI_AI_CONNECTION_DESCRIPTOR]);
