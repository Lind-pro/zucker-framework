/**
 * 把不同形状的 AI 调用结果归一化为可日志化的 summary 对象。
 *
 * 业务侧 observer / 日志写入 / 监控需要一个统一的 result shape。
 * AI 调用返回的结构差异：
 * - OpenAI ChatCompletion：`{ id, model, choices:[{message:{content}}], usage }`
 * - AICallWrapper.callWithStream 返回：`{ content, chunkCount, durationMs, usage }`
 * - Embedding API：`{ data:[{embedding:[...]}], model, usage }`
 * - 其他自定义 provider 返回任意形状
 *
 * 这里负责识别并提取关键字段（id / model / contentLength / contentPreview /
 * usage / finishReason），其他字段折叠成 `summary` string。
 */
export interface ResultSummary {
  id?: string;
  model?: string;
  finishReason?: string;
  usage?: unknown;
  contentLength?: number;
  contentPreview?: string;
  chunkCount?: number;
  durationMs?: number;
  kind?: 'chat' | 'stream' | 'embedding' | 'unknown';
  summary?: string;
  /** 原始 content 的 0/1 标志（不含正文）—— 业务侧可据此决定是否再读详情 */
  hasContent?: boolean;
}

const DEFAULT_PREVIEW_MAX = 200;

export interface SummarizeOptions {
  /** content 预览最大字符数。默认 200 */
  previewMax?: number;
}

export function summarizeAIResult(result: unknown, options: SummarizeOptions = {}): ResultSummary {
  const previewMax = options.previewMax ?? DEFAULT_PREVIEW_MAX;

  if (result === null || result === undefined) {
    return { kind: 'unknown', hasContent: false };
  }

  if (typeof result !== 'object') {
    return { kind: 'unknown', summary: truncate(String(result), previewMax), hasContent: true };
  }

  const r = result as Record<string, any>;

  // OpenAI ChatCompletion 形状
  if (Array.isArray(r.choices) && typeof r.id === 'string') {
    const content = r.choices[0]?.message?.content ?? '';
    return {
      kind: 'chat',
      id: r.id,
      model: r.model,
      finishReason: r.choices[0]?.finish_reason,
      usage: r.usage,
      contentLength: typeof content === 'string' ? content.length : 0,
      contentPreview: typeof content === 'string' ? truncate(content, previewMax) : undefined,
      hasContent: !!content,
    };
  }

  // callWithStream 聚合结果
  if (typeof r.content === 'string' && typeof r.chunkCount === 'number') {
    return {
      kind: 'stream',
      chunkCount: r.chunkCount,
      durationMs: r.durationMs,
      usage: r.usage,
      contentLength: r.content.length,
      contentPreview: truncate(r.content, previewMax),
      hasContent: r.content.length > 0,
    };
  }

  // Embedding API
  if (Array.isArray(r.data) && r.data[0]?.embedding) {
    return {
      kind: 'embedding',
      model: r.model,
      usage: r.usage,
      summary: `${r.data.length} 个 embedding，维度=${r.data[0].embedding.length}`,
      hasContent: r.data.length > 0,
    };
  }

  // 兜底：JSON 短摘要
  return {
    kind: 'unknown',
    summary: truncate(safeStringify(r), previewMax),
    hasContent: true,
  };
}

function truncate(s: string, max: number): string {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + `... [已截断，总长度: ${s.length}]`;
}

function safeStringify(o: unknown): string {
  try {
    return JSON.stringify(o);
  } catch {
    return Object.prototype.toString.call(o);
  }
}
