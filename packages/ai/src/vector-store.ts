/**
 * 向量存储接口 — RAG 框架基础。
 * 提供文档嵌入存储和相似度搜索能力。
 */
export interface VectorStore {
  /** 添加文档到向量存储 */
  addDocuments(documents: VectorDocument[]): Promise<string[]>;
  /** 相似度搜索 */
  similaritySearch(query: string, k?: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]>;
  /** 按 ID 删除文档 */
  deleteDocuments(ids: string[]): Promise<void>;
  /** 按 ID 获取文档 */
  getDocument(id: string): Promise<VectorDocument | null>;
  /** 统计文档数量 */
  count(filter?: Record<string, unknown>): Promise<number>;
}

export interface VectorDocument {
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export interface VectorSearchResult {
  document: VectorDocument;
  score: number;
  distance?: number;
}

/** 嵌入模型接口 */
export interface EmbeddingModel {
  /** 生成单个文本的嵌入向量 */
  embed(text: string): Promise<number[]>;
  /** 批量生成嵌入向量 */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** 向量维度 */
  dimensions: number;
}

export const VECTOR_STORE = 'VECTOR_STORE';
export const EMBEDDING_MODEL = 'EMBEDDING_MODEL';
