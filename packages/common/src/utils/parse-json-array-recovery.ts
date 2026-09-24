import { extractJsonCandidate } from './extract-json-candidate';

const INCOMPLETE = Symbol('incomplete JSON');
const INVALID = Symbol('invalid JSON');

/**
 * Parse a JSON object, or recover only fully received object entries in one
 * top-level array when the input ends mid-JSON. Never repairs strings/values.
 * Recovery preserves fields before the array and discards everything after its
 * last complete object entry. No complete entry, malformed syntax, an ambiguous
 * target key or excessive recovery nesting returns null. Complete valid objects
 * pass through unchanged; consumers still own schema validation.
 */
export function parseJsonWithArrayRecovery(
  raw: string,
  arrayKey: string,
): Record<string, unknown> | null {
  const { text } = extractJsonCandidate(raw);
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    // Recognize a valid JSON prefix, not arbitrary malformed JSON.
  }

  let pos = 0;
  let checkpoint = -1;
  let targetSeen = false;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[pos] ?? '\0')) pos++; };
  const requireInput = () => { if (pos >= text.length) throw INCOMPLETE; };
  const expect = (character: string) => {
    whitespace();
    requireInput();
    if (text[pos++] !== character) throw INVALID;
  };

  const string = (): string => {
    const start = pos;
    expect('"');
    while (pos < text.length) {
      const character = text[pos++];
      if (character === '"') return text.slice(start, pos);
      if (character.charCodeAt(0) < 32) throw INVALID;
      if (character !== '\\') continue;
      requireInput();
      const escaped = text[pos++];
      if (escaped === 'u') {
        for (let i = 0; i < 4; i++) {
          requireInput();
          if (!/[0-9a-fA-F]/.test(text[pos++])) throw INVALID;
        }
      } else if (!'"\\/bfnrt'.includes(escaped)) {
        throw INVALID;
      }
    }
    throw INCOMPLETE;
  };

  const number = () => {
    if (text[pos] === '-') { pos++; requireInput(); }
    if (text[pos] === '0') pos++;
    else {
      if (!/[1-9]/.test(text[pos] ?? '')) throw INVALID;
      while (/[0-9]/.test(text[pos] ?? '')) pos++;
    }
    if (text[pos] === '.') {
      pos++;
      requireInput();
      if (!/[0-9]/.test(text[pos])) throw INVALID;
      while (/[0-9]/.test(text[pos] ?? '')) pos++;
    }
    if (text[pos] === 'e' || text[pos] === 'E') {
      pos++;
      if (text[pos] === '+' || text[pos] === '-') pos++;
      requireInput();
      if (!/[0-9]/.test(text[pos])) throw INVALID;
      while (/[0-9]/.test(text[pos] ?? '')) pos++;
    }
  };

  const value = (depth: number, targetArray = false): void => {
    if (depth > 128) throw INVALID;
    whitespace();
    requireInput();
    const character = text[pos];
    if (character === '{') {
      pos++;
      whitespace();
      requireInput();
      if (text[pos] === '}') { pos++; return; }
      while (true) {
        whitespace();
        requireInput();
        const key: string = JSON.parse(string());
        const selected = depth === 0 && key === arrayKey;
        if (selected) {
          if (targetSeen) throw INVALID;
          targetSeen = true;
        }
        expect(':');
        if (selected) {
          whitespace();
          requireInput();
          if (text[pos] !== '[') throw INVALID;
        }
        value(depth + 1, selected);
        whitespace();
        requireInput();
        if (text[pos] === '}') { pos++; return; }
        expect(',');
      }
    }
    if (character === '[') {
      pos++;
      whitespace();
      requireInput();
      if (text[pos] === ']') { pos++; return; }
      while (true) {
        whitespace();
        requireInput();
        if (targetArray && text[pos] !== '{') throw INVALID;
        value(depth + 1);
        if (targetArray) checkpoint = pos;
        whitespace();
        requireInput();
        if (text[pos] === ']') { pos++; return; }
        expect(',');
      }
    }
    if (character === '"') { string(); return; }
    if (character === '-' || /[0-9]/.test(character)) { number(); return; }
    const literal = character === 't' ? 'true' : character === 'f' ? 'false' : character === 'n' ? 'null' : null;
    if (!literal) throw INVALID;
    for (const expected of literal) {
      requireInput();
      if (text[pos++] !== expected) throw INVALID;
    }
  };

  try {
    whitespace();
    if (text[pos] !== '{') return null;
    value(0);
    // Complete-but-invalid JSON must not enter truncation recovery.
    return null;
  } catch (error) {
    if (error !== INCOMPLETE || checkpoint < 0) return null;
    try {
      return JSON.parse(text.slice(0, checkpoint) + ']}') as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
