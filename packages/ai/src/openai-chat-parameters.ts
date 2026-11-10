interface OpenAIChatParameters {
  model?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  thinking?: unknown;
  reasoning_effort?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  logprobs?: unknown;
  top_logprobs?: unknown;
}

export function isOfficialOpenAIChatEndpoint(url: URL): boolean {
  return url.origin === 'https://api.openai.com' &&
    url.pathname.replace(/\/$/, '') === '/v1/chat/completions';
}

/** Shared by the native SDK adapter and LangChain's cloned completion clients. */
export function normalizeOpenAIChatParameters(params: OpenAIChatParameters): void {
  if (params.max_tokens !== undefined) {
    params.max_completion_tokens ??= params.max_tokens;
    delete params.max_tokens;
  }
  // Compatible-provider thinking is not an OpenAI request parameter.
  delete params.thinking;
  if (typeof params.model === 'string' && /^gpt-6(?:[.-]|$)/.test(params.model) &&
      params.reasoning_effort !== 'none') {
    delete params.temperature;
    delete params.top_p;
    delete params.logprobs;
    delete params.top_logprobs;
  }
}
