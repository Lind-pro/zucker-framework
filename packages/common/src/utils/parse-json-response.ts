/**
 * Parse a JSON response string, handling common LLM output quirks:
 * - Strips markdown code fences (```json ... ```)
 * - Strips leading/trailing whitespace
 * - Returns the parsed object, or the raw string if parsing fails
 */
export function parseJsonResponse<T = unknown>(text: string): T {
  if (!text || typeof text !== 'string') return text as unknown as T;

  let cleaned = text.trim();

  // Strip markdown code fences
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return cleaned as unknown as T;
  }
}
