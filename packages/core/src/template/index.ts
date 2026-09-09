/**
 * TemplateParser — 模板解析
 *
 * - 支持可配置的开始/结束符号
 * - 支持 HTML 转义（XSS 防护）
 * - 支持嵌套属性访问（a.b.c）
 * - 支持自定义属性映射函数
 */

export interface ParseTemplateOptions {
  /** When true, HTML-escape substituted values to prevent XSS. Default: false */
  escapeHtml?: boolean;
  /**
   * 开始符号，默认 "${"
   */
  startSymbol?: string;
  /**
   * 结束符号，默认 "}"
   */
  endSymbol?: string;
}

export function parseTemplate(
  template: string,
  variables: Record<string, unknown>,
  options?: ParseTemplateOptions,
): string {
  return parseTemplateWithMapper(template, (key) => {
    const value = getNestedValue(variables, key);
    if (value === undefined) return '';
    const str = String(value);
    return options?.escapeHtml ? escapeHtmlChars(str) : str;
  }, options);
}

/**
 * 使用自定义映射函数解析模板
 *
 * @param template - 模板字符串
 * @param mapper - 属性名到替换值的映射函数
 * @param options - 可选的配置（开始/结束符号）
 */
export function parseTemplateWithMapper(
  template: string,
  mapper: (key: string) => string,
  options?: Pick<ParseTemplateOptions, 'startSymbol' | 'endSymbol'>,
): string {
  const startSymbol = options?.startSymbol ?? '${';
  const endSymbol = options?.endSymbol ?? '}';

  // 使用状态机解析模板占位符
  const result: string[] = [];
  let pos = 0;

  while (pos < template.length) {
    const startIdx = template.indexOf(startSymbol, pos);
    if (startIdx === -1) {
      result.push(template.substring(pos));
      break;
    }

    // 添加 startSymbol 之前的文本
    if (startIdx > pos) {
      result.push(template.substring(pos, startIdx));
    }

    const exprStart = startIdx + startSymbol.length;
    const endIdx = template.indexOf(endSymbol, exprStart);
    if (endIdx === -1) {
      // 未闭合的表达式，原样保留
      result.push(template.substring(startIdx));
      break;
    }

    const expression = template.substring(exprStart, endIdx);
    result.push(mapper(expression));
    pos = endIdx + endSymbol.length;
  }

  return result.join('');
}

/**
 * Escape HTML special characters to prevent XSS when template output
 * is rendered in HTML contexts.
 */
function escapeHtmlChars(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], obj);
}
