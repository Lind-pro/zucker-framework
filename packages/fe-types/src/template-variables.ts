/** 匹配 {{variableName}} 占位符（仅 \w：字母数字下划线） */
export const TEMPLATE_VARIABLE_REGEX = /\{\{(\w+)\}\}/g;

/** 从一段或多段 HTML 中提取所有 {{variable}} 名称，去重 */
export function extractTemplateVariables(...htmls: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const html of htmls) {
    if (!html) continue;
    // 用 matchAll（不依赖 lastIndex 状态），可安全复用全局 regex
    for (const m of html.matchAll(TEMPLATE_VARIABLE_REGEX)) {
      found.add(m[1]);
    }
  }
  return [...found];
}
