/**
 * Elasticsearch 查询构建器 — 流式 API。
 * 对标 hsweb QueryParam / DynamicQueryService 的查询构建能力。
 */
export class SearchQueryBuilder {
  private _index = '';
  private _query: Record<string, unknown> = { bool: { must: [], should: [], must_not: [], filter: [] } };
  private _from?: number;
  private _size?: number;
  private _sort: Array<Record<string, 'asc' | 'desc'>> = [];
  private _highlight?: { fields: Record<string, Record<string, unknown>> };
  private _source?: string[];

  static create(index: string): SearchQueryBuilder {
    const b = new SearchQueryBuilder();
    b._index = index;
    return b;
  }

  /** 全文搜索 */
  match(field: string, value: string | number): this {
    (this._query.bool as any).must.push({ match: { [field]: value } });
    return this;
  }

  /** 多字段全文搜索 */
  multiMatch(fields: string[], value: string): this {
    (this._query.bool as any).must.push({ multi_match: { query: value, fields } });
    return this;
  }

  /** 精确匹配 */
  term(field: string, value: string | number | boolean): this {
    (this._query.bool as any).filter.push({ term: { [field]: value } });
    return this;
  }

  /** 范围查询 */
  range(field: string, opts: { gte?: number | string; lte?: number | string; gt?: number | string; lt?: number | string }): this {
    (this._query.bool as any).filter.push({ range: { [field]: opts } });
    return this;
  }

  /** 包含 */
  terms(field: string, values: Array<string | number>): this {
    (this._query.bool as any).filter.push({ terms: { [field]: values } });
    return this;
  }

  /** 存在性 */
  exists(field: string): this {
    (this._query.bool as any).filter.push({ exists: { field } });
    return this;
  }

  /** 模糊匹配 */
  wildcard(field: string, pattern: string): this {
    (this._query.bool as any).must.push({ wildcard: { [field]: pattern } });
    return this;
  }

  /** 排除 */
  mustNot(field: string, value: string | number): this {
    (this._query.bool as any).must_not.push({ term: { [field]: value } });
    return this;
  }

  /** OR 条件 */
  should(field: string, value: string | number): this {
    (this._query.bool as any).should.push({ match: { [field]: value } });
    return this;
  }

  /** 分页 */
  page(page: number, size: number): this {
    this._from = (page - 1) * size;
    this._size = size;
    return this;
  }

  /** 排序 */
  sort(field: string, order: 'asc' | 'desc' = 'asc'): this {
    this._sort.push({ [field]: order });
    return this;
  }

  /** 高亮 */
  highlight(...fields: string[]): this {
    this._highlight = { fields: {} };
    for (const f of fields) {
      this._highlight.fields[f] = {};
    }
    return this;
  }

  /** 选择返回字段 */
  select(...fields: string[]): this {
    this._source = fields;
    return this;
  }

  /** 构建查询对象 */
  build(): { index: string; query: Record<string, unknown>; from?: number; size?: number; sort?: Array<Record<string, 'asc' | 'desc'>>; highlight?: any; _source?: string[] } {
    // 清理空数组
    const bool = this._query.bool as any;
    if (bool.must.length === 0) delete bool.must;
    if (bool.should.length === 0) delete bool.should;
    if (bool.must_not.length === 0) delete bool.must_not;
    if (bool.filter.length === 0) delete bool.filter;

    const hasClauses = Object.keys(bool).length > 0;
    const query = hasClauses ? this._query : { match_all: {} };

    const result: any = { index: this._index, query };
    if (this._from !== undefined) result.from = this._from;
    if (this._size !== undefined) result.size = this._size;
    if (this._sort.length > 0) result.sort = this._sort;
    if (this._highlight) result.highlight = this._highlight;
    if (this._source) result._source = this._source;
    return result;
  }
}
