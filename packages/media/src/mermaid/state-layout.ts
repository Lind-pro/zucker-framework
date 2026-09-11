/**
 * Mermaid's state renderer overlays parallel self transitions. Render their
 * labels together on the same self transition so every original condition and
 * action remains visible. The saved source is never changed.
 */
export function prepareStateLayout(source: string): {
  source: string;
  hasSelfTransitions: boolean;
} {
  const lines = source.split('\n');
  const groups = new Map<string, number>();
  const scopes = [0];
  let scopeSequence = 0;
  let inNote = false;
  let hasSelfTransitions = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inNote) {
      if (/^\s*end note\s*$/i.test(line)) inNote = false;
      continue;
    }
    if (/^\s*note\b/i.test(line)) {
      inNote = !line.includes(':');
      continue;
    }
    if (/^\s*state\b.*\{\s*(?:%%.*)?$/.test(line)) {
      scopes.push(++scopeSequence);
      continue;
    }
    if (/^\s*}\s*(?:%%.*)?$/.test(line)) {
      if (scopes.length > 1) scopes.pop();
      continue;
    }
    if (/^\s*--\s*(?:%%.*)?$/.test(line)) {
      // Concurrent regions inside a composite state are separate documents.
      groups.clear();
      continue;
    }
    // Only unambiguous single-line self transitions are combined. Start/end
    // markers and differently scoped states have independent semantics.
    const match = /^(\s*)([^\s:]+)\s*-->\s*([^\s:]+)\s*:\s*(\S.*)$/.exec(line);
    if (!match || match[2] !== match[3] || match[2] === '[*]') continue;
    hasSelfTransitions = true;
    const key = `${scopes[scopes.length - 1]}:${match[2]}`;
    // Do not concatenate into a line whose trailing comment could consume the
    // next transition. Keep ambiguous/commented groups untouched.
    if (line.includes('%%')) {
      groups.delete(key);
      continue;
    }
    const firstIndex = groups.get(key);
    if (firstIndex === undefined) {
      groups.set(key, index);
    } else {
      lines[firstIndex] += `<br/>${match[4]}`;
      lines[index] = '';
    }
  }

  return { source: lines.join('\n'), hasSelfTransitions };
}
