import { jsonrepair } from 'jsonrepair';

export interface RepairedJsonLogger {
  warn(message: string): void;
  error(message: string): void;
}

export class JsonResponseParseError extends Error {
  constructor(
    readonly code: 'EMPTY_CONTENT' | 'INVALID_JSON',
    options?: ErrorOptions,
  ) {
    super(
      code === 'EMPTY_CONTENT' ? 'JSON response content is empty' : 'Unable to parse JSON response',
      options,
    );
    this.name = 'JsonResponseParseError';
  }
}

/**
 * 从文本中提取第一个完整的 JSON 对象或数组（基于括号匹配，忽略字符串内部的符号）
 */
function extractFirstJsonBlock(content: string): string | null {
  let start = -1;
  const stack: ('{' | '[')[] = [];
  let inString = false;
  let escape = false;
  let quoteChar: string | null = null;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === quoteChar) {
        inString = false;
        quoteChar = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quoteChar = char;
      continue;
    }

    if (char === '{' || char === '[') {
      if (start === -1) {
        start = i;
      }
      stack.push(char === '{' ? '{' : '[');
    } else if (char === '}' || char === ']') {
      if (start !== -1 && stack.length > 0) {
        const expected = char === '}' ? '{' : '[';
        if (stack[stack.length - 1] === expected) {
          stack.pop();
          if (stack.length === 0) {
            return content.substring(start, i + 1);
          }
        } else {
          // 括号不匹配，直接失败，重新开始查找
          start = -1;
          stack.length = 0;
        }
      }
    }
  }

  return null;
}

/**
 * 快速修复常见的JSON语法错误
 */
function attemptQuickFix(str: string): string {
  // 修复 \"\" 为 \"（生成器可能生成转义双引号后多一个双引号）
  let fixed = str.replace(/\\\"\"/g, '\\"');
  // 修复 "" 为 "（双引号重复）
  fixed = fixed.replace(/\"\"/g, '"');
  // 移除 生成器 可能添加的额外标记（如 }# 结尾或其他注释标记）
  // 匹配 }# 后面跟着任意非 JSON 字符
  fixed = fixed.replace(/\}#[^{}\[\]"]*(?=[}\]]|$)/g, '}');
  fixed = fixed.replace(/\]#[^{}\[\]"]*(?=[}\]]|$)/g, ']');
  // 移除字符串值中的 }# 标记（在引号内的内容）
  fixed = fixed.replace(/"([^"]*)\}#([^"]*)"/g, (_match, before, after) => {
    return `"${before}${after}"`;
  });
  return fixed;
}

/**
 * 尝试修复截断的 JSON（生成器 输出被截断时使用）
 */
function attemptTruncatedJsonFix(str: string): string {
  let fixed = str.trim();

  // 统计未闭合的括号
  let braceCount = 0; // {}
  let bracketCount = 0; // []
  let inString = false;
  let escape = false;

  for (let i = 0; i < fixed.length; i++) {
    const char = fixed[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      braceCount++;
    } else if (char === '}') {
      braceCount--;
    } else if (char === '[') {
      bracketCount++;
    } else if (char === ']') {
      bracketCount--;
    }
  }

  // 如果在字符串中被截断，先闭合字符串
  if (inString) {
    // 移除最后一个不完整的字符串值，找到最后一个完整的字段
    const lastCompleteField = fixed.lastIndexOf('",');
    const lastCompleteFieldAlt = fixed.lastIndexOf('": "');

    if (lastCompleteField > lastCompleteFieldAlt && lastCompleteField > fixed.length - 500) {
      // 截断到最后一个完整字段
      fixed = fixed.substring(0, lastCompleteField + 1);
      // 重新计算括号
      braceCount = 0;
      bracketCount = 0;
      inString = false;
      for (let i = 0; i < fixed.length; i++) {
        const char = fixed[i];
        if (inString) {
          if (char === '\\' && i + 1 < fixed.length) {
            i++;
            continue;
          }
          if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        else if (char === '[') bracketCount++;
        else if (char === ']') bracketCount--;
      }
    } else {
      // 简单闭合字符串
      fixed += '..."';
    }
  }

  // 闭合括号
  while (bracketCount > 0) {
    fixed += ']';
    bracketCount--;
  }
  while (braceCount > 0) {
    fixed += '}';
    braceCount--;
  }

  return fixed;
}

/**
 * Parse generated JSON using the established repair sequence: direct parse,
 * quick syntax repair, jsonrepair, truncated completion, then a balanced block.
 * Unlike parseJsonResponse, exhausted repairs throw instead of returning unparsed input.
 * This does not validate business schemas; consumers own validation/fallback.
 * Diagnostic logs contain lengths and repair failures, never the input payload.
 */
export function parseRepairedJsonResponse<T = unknown>(
  content: string | null,
  logger?: RepairedJsonLogger,
): T {
  if (!content) throw new JsonResponseParseError('EMPTY_CONTENT');
  let jsonContent = content.trim();
  const markdownMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (markdownMatch?.[1]) jsonContent = markdownMatch[1].trim();
  jsonContent = jsonContent.replace(/^\uFEFF/, '').trim();

  try {
    return JSON.parse(jsonContent) as T;
  } catch {
    try {
      return JSON.parse(attemptQuickFix(jsonContent)) as T;
    } catch {
      try {
        return JSON.parse(jsonrepair(jsonContent)) as T;
      } catch {
        try {
          const fixed = attemptTruncatedJsonFix(jsonContent);
          logger?.warn(
            `Attempting truncated JSON repair (inputLength=${jsonContent.length}, repairedLength=${fixed.length})`,
          );
          return JSON.parse(fixed) as T;
        } catch (error) {
          const extracted = extractFirstJsonBlock(jsonContent);
          if (!extracted) {
            logger?.error('Unable to parse JSON response');
            throw new JsonResponseParseError('INVALID_JSON', { cause: error });
          }
          try {
            return JSON.parse(attemptQuickFix(extracted)) as T;
          } catch {
            try {
              return JSON.parse(attemptTruncatedJsonFix(extracted)) as T;
            } catch {
              try {
                return JSON.parse(jsonrepair(extracted)) as T;
              } catch (repairError) {
                logger?.error('Extracted JSON block repair failed');
                throw repairError;
              }
            }
          }
        }
      }
    }
  }
}
