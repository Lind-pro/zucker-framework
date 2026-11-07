// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ommlToLatex, readDocxDocumentText } from './docx-math';

const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const r = (text: string, props = '') => `<m:r>${props ? `<m:rPr>${props}</m:rPr>` : ''}<m:t>${text}</m:t></m:r>`;
const math = (inner: string) => `<m:oMath ${M}>${inner}</m:oMath>`;

describe('Word equations as LaTeX', () => {
  it('converts subscripts, fractions, roots and Greek letters', () => {
    const omega = `<m:sSub><m:e>${r('ω')}</m:e><m:sub>${r('n')}</m:sub></m:sSub>`;
    const frac = `<m:f><m:num>${r('1')}</m:num><m:den><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r('1−')}<m:sSup><m:e>${r('ζ')}</m:e><m:sup>${r('2')}</m:sup></m:sSup></m:e></m:rad></m:den></m:f>`;
    expect(ommlToLatex(math(`${omega}${r('=')}${frac}`))).toBe('\\omega_{n}=\\frac{1}{\\sqrt{1-\\zeta^{2}}}');
  });

  it('keeps delimiters, sums, accents, plain text and matrices', () => {
    const delim = `<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr><m:e>${r('x')}</m:e></m:d>`;
    const sum = `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${r('k=1')}</m:sub><m:sup>${r('K')}</m:sup><m:e><m:sSub><m:e>${r('A')}</m:e><m:sub>${r('k')}</m:sub></m:sSub></m:e></m:nary>`;
    const hat = `<m:acc><m:accPr><m:chr m:val="&#770;"/></m:accPr><m:e>${r('v')}</m:e></m:acc>`;
    const word = r('RMS', '<m:sty m:val="p"/>');
    const matrix = `<m:m><m:mr><m:e>${r('a')}</m:e><m:e>${r('b')}</m:e></m:mr><m:mr><m:e>${r('c')}</m:e><m:e>${r('d')}</m:e></m:mr></m:m>`;
    const latex = ommlToLatex(math(`${delim}${sum}${hat}${word}${matrix}`));
    expect(latex).toContain('\\left\\{x\\right.');
    expect(latex).toContain('\\sum_{k=1}^{K} A_{k}');
    expect(latex).toContain('\\hat{v}');
    expect(latex).toContain('\\mathrm{RMS}');
    expect(latex).toContain('\\begin{matrix}a & b \\\\ c & d\\end{matrix}');
  });

  it('reads document text with inline and display equations and table cells', () => {
    const xml = `<w:document ${W} ${M}><w:body>
      <w:p><w:r><w:t xml:space="preserve">natural frequency </w:t></w:r>${math(`<m:sSub><m:e>${r('ω')}</m:e><m:sub>${r('n')}</m:sub></m:sSub>`)}<w:r><w:t xml:space="preserve"> and damping ratio </w:t></w:r>${math(r('ζ'))}</w:p>
      <w:p><m:oMathPara>${math(`${r('y')}${r('=')}${r('x')}`)}</m:oMathPara></w:p>
      <w:p><w:r><w:delText>removed</w:delText></w:r><w:r><w:t>[0039]</w:t><w:tab/><w:t>kept</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Artery</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>8.0</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`;
    expect(readDocxDocumentText(xml)).toBe('natural frequency $\\omega_{n}$ and damping ratio $\\zeta$\n$$y=x$$\n[0039]\tkept\nArtery\t8.0');
  });

  it('rejects entity declarations', () => {
    expect(() => readDocxDocumentText('<!DOCTYPE x [<!ENTITY a "b">]><w:document/>')).toThrow();
  });
});

describe('LaTeX commands next to letters', () => {
  it('separates a command from letters in the next run so it stays valid', () => {
    expect(ommlToLatex(math(`${r('δ')}${r('t')}${r('=Δ')}${r('t')}${r('j')}${r('ω')}${r('T')}`))).toBe('\\delta t=\\Delta tj\\omega T');
    expect(ommlToLatex(math(r('MAD​')))).toBe('MAD');
  });
});
