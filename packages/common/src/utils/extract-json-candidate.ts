/** Extract the earliest object/array root and report whether its delimiters close. */
export function extractJsonCandidate(rawText: string): {
  text: string;
  truncated: boolean;
} {
  const objectStart = rawText.indexOf('{');
  const arrayStart = rawText.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) return { text: rawText, truncated: false };

  const start = Math.min(...starts);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < rawText.length; index += 1) {
    const character = rawText[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      stack.push('}');
    } else if (character === '[') {
      stack.push(']');
    } else if (character === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        return {
          text: rawText.slice(start, index + 1),
          truncated: false,
        };
      }
    }
  }

  return { text: rawText.slice(start), truncated: true };
}
