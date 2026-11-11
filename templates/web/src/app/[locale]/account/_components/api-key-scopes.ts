/**
 * API-key scopes the account page offers (the server's allow-list is `account:read` and `ai:generate`).
 * `account:read` is always granted; `ai:generate` spends credits, so it is opt-in. Pure: node tests load it.
 */
export const API_KEY_SCOPES = ["account:read", "ai:generate"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export function selectedApiKeyScopes(aiGenerate: boolean): ApiKeyScope[] {
  return aiGenerate ? ["account:read", "ai:generate"] : ["account:read"];
}

/** Scopes of a listed key, known ones first in a stable order; unknown strings are kept for display. */
export function displayApiKeyScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  const values = scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0 && scope.length <= 64);
  const known = API_KEY_SCOPES.filter(scope => values.includes(scope));
  return [...known, ...values.filter(scope => !(API_KEY_SCOPES as readonly string[]).includes(scope))];
}
