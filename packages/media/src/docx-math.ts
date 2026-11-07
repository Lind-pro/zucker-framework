import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Word documents keep equations as Office Math (OMML), which plain-text DOCX
 * readers drop entirely. These functions keep them as LaTeX: `ommlToLatex`
 * converts one equation, and `readDocxDocumentText` reads `word/document.xml`
 * as text with inline equations in `$…$` and display equations in `$$…$$`.
 */

type XmlNode = Record<string, unknown>;
const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', textNodeName: '#text',
  trimValues: false, parseTagValue: false, processEntities: true,
});

const tagOf = (node: XmlNode) => Object.keys(node).find((key) => key !== ':@') ?? '';
const local = (name: string) => name.split(':').at(-1) ?? name;
const kids = (node: XmlNode): XmlNode[] => (Array.isArray(node[tagOf(node)]) ? (node[tagOf(node)] as XmlNode[]) : []);
const attr = (node: XmlNode | undefined, name: string): string | undefined => {
  const attributes = node?.[':@'];
  if (!attributes || typeof attributes !== 'object') return undefined;
  return Object.entries(attributes as Record<string, string>).find(([key]) => local(key) === name)?.[1];
};
const childOf = (node: XmlNode | undefined, name: string) => (node ? kids(node).find((item) => local(tagOf(item)) === name) : undefined);
const childrenOf = (node: XmlNode, name: string) => kids(node).filter((item) => local(tagOf(item)) === name);
const prop = (node: XmlNode, propName: string, valueName: string) => attr(childOf(childOf(node, propName), valueName), 'val');
const flag = (node: XmlNode, propName: string, valueName: string) => {
  const holder = childOf(childOf(node, propName), valueName);
  if (!holder) return false;
  const value = attr(holder, 'val');
  return value === undefined || ['1', 'on', 'true'].includes(value);
};

function parse(xml: string): XmlNode[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX XML must not declare entities');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Invalid DOCX XML: ${valid.err.msg}`);
  return parser.parse(xml) as XmlNode[];
}

const GREEK: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta',
  θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi',
  ρ: '\\rho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon', φ: '\\phi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi',
  ω: '\\omega', Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma',
  Υ: '\\Upsilon', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
};
const SYMBOLS: Record<string, string> = {
  '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '÷': '\\div', '±': '\\pm', '∓': '\\mp', '≤': '\\le', '≥': '\\ge',
  '≠': '\\ne', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim', '∝': '\\propto', '∞': '\\infty', '∂': '\\partial',
  '∇': '\\nabla', '→': '\\to', '←': '\\leftarrow', '⇒': '\\Rightarrow', '⇔': '\\Leftrightarrow', '∈': '\\in',
  '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq', '∪': '\\cup', '∩': '\\cap', '∀': '\\forall', '∃': '\\exists',
  '…': '\\ldots', '⋯': '\\cdots', '′': "'", '″': "''", '−': '-', '∘': '\\circ', '°': '^{\\circ}', 'ℏ': '\\hbar',
  '√': '\\surd', '∠': '\\angle', '⊥': '\\perp', '∥': '\\parallel', '‖': '\\|', '⟨': '\\langle', '⟩': '\\rangle',
};
const ESCAPE: Record<string, string> = { '#': '\\#', $: '\\$', '%': '\\%', '&': '\\&', _: '\\_', '{': '\\{', '}': '\\}', '\\': '\\backslash ', '~': '\\sim ', '^': '\\hat{}' };
const ACCENTS: Record<string, string> = {
  '̂': '\\hat', '^': '\\hat', '̃': '\\tilde', '~': '\\tilde', '̄': '\\bar', '̅': '\\overline',
  '‾': '\\overline', '̇': '\\dot', '̈': '\\ddot', '⃛': '\\dddot', '⃗': '\\vec', '́': '\\acute',
  '̀': '\\grave', '̆': '\\breve', '̌': '\\check',
};
const NARY: Record<string, string> = {
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge',
};
const DELIMITERS: Record<string, string> = { '{': '\\{', '}': '\\}', '|': '|', '‖': '\\|', '⟨': '\\langle', '⟩': '\\rangle', '⌈': '\\lceil', '⌉': '\\rceil', '⌊': '\\lfloor', '⌋': '\\rfloor', '': '.' };
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'arg', 'det', 'dim', 'gcd', 'deg', 'Pr', 'ker']);
const SCRIPTS: Record<string, string> = { 'double-struck': '\\mathbb', fraktur: '\\mathfrak', script: '\\mathcal', 'sans-serif': '\\mathsf', monospace: '\\mathtt' };

function mathText(text: string): string {
  // Zero-width characters carry no meaning in an equation and have no glyph metrics.
  return joinLatex([...text.replace(/[\u200b-\u200d\ufeff]/g, '')].map((ch) => GREEK[ch] ?? SYMBOLS[ch] ?? ESCAPE[ch] ?? ch));
}
const group = (latex: string) => (/^(?:[A-Za-z0-9]|\\[a-zA-Z]+)$/.test(latex) ? latex : `{${latex}}`);

function runText(run: XmlNode): string {
  const raw = kids(run).filter((item) => local(tagOf(item)) === 't').map((t) => kids(t).map((n) => String(n['#text'] ?? '')).join('')).join('');
  if (!raw) return '';
  const plain = flag(run, 'rPr', 'nor') || prop(run, 'rPr', 'sty') === 'p';
  const script = SCRIPTS[prop(run, 'rPr', 'scr') ?? ''];
  const bold = ['b', 'bi'].includes(prop(run, 'rPr', 'sty') ?? '');
  let latex = mathText(raw);
  if (plain && /[A-Za-z]{2,}/.test(raw)) latex = FUNCTIONS.has(raw.trim()) ? `\\${raw.trim()} ` : `\\mathrm{${latex}}`;
  if (script) latex = `${script}{${latex}}`;
  if (bold) latex = `\\mathbf{${latex}}`;
  return latex;
}

/** Joins LaTeX pieces so a command never absorbs the letters that follow it (\\delta + t). */
function joinLatex(pieces: string[]): string {
  return pieces.reduce((out, piece) => (/\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z]/.test(piece) ? `${out} ${piece}` : out + piece), '');
}
function convert(nodes: XmlNode[]): string {
  return joinLatex(nodes.map(convertNode));
}
const arg = (node: XmlNode, name: string) => convert(kids(childOf(node, name) ?? {}));

function convertNode(node: XmlNode): string {
  const name = local(tagOf(node));
  if (name.endsWith('Pr') || name === 'ctrlPr') return '';
  switch (name) {
    case '#text': return '';
    case 'r': return runText(node);
    case 'f': {
      const num = arg(node, 'num'), den = arg(node, 'den');
      const type = prop(node, 'fPr', 'type');
      if (type === 'lin') return `${group(num)}/${group(den)}`;
      if (type === 'noBar') return `\\genfrac{}{}{0pt}{}{${num}}{${den}}`;
      return `\\frac{${num}}{${den}}`;
    }
    case 'sSup': return `${group(arg(node, 'e'))}^{${arg(node, 'sup')}}`;
    case 'sSub': return `${group(arg(node, 'e'))}_{${arg(node, 'sub')}}`;
    case 'sSubSup': return `${group(arg(node, 'e'))}_{${arg(node, 'sub')}}^{${arg(node, 'sup')}}`;
    case 'sPre': return `{}_{${arg(node, 'sub')}}^{${arg(node, 'sup')}}${group(arg(node, 'e'))}`;
    case 'rad': {
      const degree = flag(node, 'radPr', 'degHide') ? '' : arg(node, 'deg');
      return degree ? `\\sqrt[${degree}]{${arg(node, 'e')}}` : `\\sqrt{${arg(node, 'e')}}`;
    }
    case 'd': {
      const open = prop(node, 'dPr', 'begChr') ?? '(';
      const close = prop(node, 'dPr', 'endChr') ?? ')';
      const separator = prop(node, 'dPr', 'sepChr') ?? '|';
      const items = childrenOf(node, 'e').map((item) => convert(kids(item)));
      const sep = separator === '' ? '' : separator === '|' ? ' \\mid ' : mathText(separator);
      return `\\left${DELIMITERS[open] ?? open}${items.join(sep)}\\right${DELIMITERS[close] ?? close}`;
    }
    case 'nary': {
      const operator = NARY[prop(node, 'naryPr', 'chr') ?? '∫'] ?? mathText(prop(node, 'naryPr', 'chr') ?? '');
      const sub = flag(node, 'naryPr', 'subHide') ? '' : arg(node, 'sub');
      const sup = flag(node, 'naryPr', 'supHide') ? '' : arg(node, 'sup');
      return `${operator}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''} ${arg(node, 'e')}`;
    }
    case 'func': {
      const fname = convert(kids(childOf(node, 'fName') ?? {})).trim();
      const plain = fname.replace(/^\\mathrm\{(.*)\}$/, '$1');
      const head = FUNCTIONS.has(plain) ? `\\${plain}` : /^[A-Za-z]{2,}$/.test(plain) ? `\\operatorname{${plain}}` : fname;
      return `${head}${group(arg(node, 'e'))}`;
    }
    case 'limLow': {
      const base = arg(node, 'e').trim();
      return `${FUNCTIONS.has(base.replace(/^\\mathrm\{(.*)\}$/, '$1')) ? `\\${base.replace(/^\\mathrm\{(.*)\}$/, '$1')}` : group(base)}_{${arg(node, 'lim')}}`;
    }
    case 'limUpp': return `\\overset{${arg(node, 'lim')}}{${arg(node, 'e')}}`;
    case 'acc': return `${ACCENTS[prop(node, 'accPr', 'chr') ?? '̂'] ?? '\\hat'}{${arg(node, 'e')}}`;
    case 'bar': return `${prop(node, 'barPr', 'pos') === 'bot' ? '\\underline' : '\\overline'}{${arg(node, 'e')}}`;
    case 'groupChr': {
      const top = prop(node, 'groupChrPr', 'pos') === 'top';
      return `${top ? '\\overbrace' : '\\underbrace'}{${arg(node, 'e')}}`;
    }
    case 'eqArr': return `\\begin{aligned}${childrenOf(node, 'e').map((item) => convert(kids(item))).join(' \\\\ ')}\\end{aligned}`;
    case 'm': {
      const rows = childrenOf(node, 'mr').map((row) => childrenOf(row, 'e').map((cell) => convert(kids(cell))).join(' & '));
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
    }
    case 'phant': return flag(node, 'phantPr', 'show') ? arg(node, 'e') : '';
    case 'box': case 'borderBox': case 'e': case 'num': case 'den': case 'sub': case 'sup':
    case 'deg': case 'lim': case 'fName': case 'oMath': case 'oMathPara':
    default: return convert(kids(node));
  }
}

/** Converts one `<m:oMath>` or `<m:oMathPara>` element (any namespace prefix) to LaTeX. */
export function ommlToLatex(xml: string): string {
  const roots = parse(xml).filter((node) => ['oMath', 'oMathPara'].includes(local(tagOf(node))));
  return roots.map(mathNode).join(' ').replace(/\s+/g, ' ').trim();
}
function mathNode(node: XmlNode): string {
  if (local(tagOf(node)) === 'oMathPara') return childrenOf(node, 'oMath').map(mathNode).join(' \\\\ ');
  return convert(kids(node)).replace(/\s+/g, ' ').trim();
}

/**
 * Reads the body of `word/document.xml` as plain text, one line per paragraph,
 * table cells separated by tabs. Equations become `$…$` (inline) or `$$…$$`
 * (display), so they survive into text-only processing.
 */
export function readDocxDocumentText(documentXml: string): string {
  const out: string[] = [];
  const body = findFirst(parse(documentXml), 'body');
  for (const block of body ? kids(body) : []) blockText(block, out);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function findFirst(nodes: XmlNode[], name: string): XmlNode | undefined {
  for (const node of nodes) {
    if (local(tagOf(node)) === name) return node;
    const found = findFirst(kids(node), name);
    if (found) return found;
  }
  return undefined;
}
function blockText(node: XmlNode, out: string[]): void {
  const name = local(tagOf(node));
  if (name === 'p') out.push(inlineText(kids(node)));
  else if (name === 'tbl') {
    for (const row of childrenOf(node, 'tr')) {
      out.push(childrenOf(row, 'tc').map((cell) => { const lines: string[] = []; kids(cell).forEach((item) => blockText(item, lines)); return lines.join(' ').trim(); }).join('\t'));
    }
    out.push('');
  } else if (name === 'oMathPara') out.push(`$$${mathNode(node)}$$`);
  else if (['sdt', 'sdtContent', 'customXml', 'smartTag', 'ins', 'moveTo'].includes(name)) kids(node).forEach((item) => blockText(item, out));
}
function inlineText(nodes: XmlNode[]): string {
  return nodes.map((node) => {
    const name = local(tagOf(node));
    if (name === 'oMathPara') return `$$${mathNode(node)}$$`;
    if (name === 'oMath') return `$${mathNode(node)}$`;
    if (name === '#text') return String(node['#text'] ?? '');
    if (name === 'tab') return '\t';
    if (name === 'br' || name === 'cr') return '\n';
    if (name === 'noBreakHyphen') return '‑';
    // Deleted text, field codes and properties are not displayed document text.
    if (['del', 'moveFrom', 'delText', 'instrText', 'delInstrText', 'pPr', 'rPr', 'fldChar'].includes(name) || name.endsWith('Pr')) return '';
    if (name === 'AlternateContent') {
      const fallback = childOf(node, 'Fallback') ?? childOf(node, 'Choice');
      return fallback ? inlineText(kids(fallback)) : '';
    }
    return inlineText(kids(node));
  }).join('');
}
