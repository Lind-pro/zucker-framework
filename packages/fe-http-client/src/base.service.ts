import type { HttpClient } from './http-client';

// 基础查询参数接口
export interface BaseQueryParams {
  current?: number;
  pageSize?: number;
  [key: string]: unknown;
}

// 操作符映射类型
export type OperatorMap = Record<string, string>;

// 基础响应接口
export interface BaseResponse<T> {
  data: T[];
  total: number;
  success?: boolean;
}

// 分页响应接口
export interface PageResponse<T> {
  data: T[];
  total: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
}

/**
 * Base Service 配置
 */
export interface BaseServiceConfig {
  /** HTTP 客户端实例 */
  httpClient: HttpClient;
  /** API路径，如'/records' */
  apiPath: string;
  /** 字段与查询操作符的映射 */
  operatorMap?: OperatorMap;
  /** 默认日期字段名称，用于日期范围查询 */
  defaultDateField?: string;
  /** 只读字段列表 - 这些字段不会在 create/update 时发送到后端 */
  readOnlyFields?: string[];
}

/**
 * 通用CRUD服务基类
 * @template T 实体类型
 * @template Q 查询参数类型，默认为BaseQueryParams
 */
export class BaseService<T extends { id: string }, Q extends BaseQueryParams = BaseQueryParams> {
  protected readonly http: HttpClient;
  protected readonly apiPath: string;
  protected readonly operatorMap: OperatorMap;
  protected readonly defaultDateField: string;
  protected readonly readOnlyFields: string[];

  /**
   * 构造函数
   */
  constructor(config: BaseServiceConfig) {
    this.http = config.httpClient;
    this.apiPath = config.apiPath;
    this.operatorMap = config.operatorMap || {};
    this.defaultDateField = config.defaultDateField || 'createTime';
    this.readOnlyFields = config.readOnlyFields || [];
  }

  /**
   * 过滤掉只读字段
   */
  private filterReadOnlyFields(data: Partial<T>): Partial<T> {
    if (this.readOnlyFields.length === 0) {
      return data;
    }
    const filtered = { ...data };
    this.readOnlyFields.forEach((field) => {
      delete (filtered as any)[field];
    });
    return filtered;
  }

  /**
   * 获取所有记录，支持分页和筛选
   */
  async getAll(params: Q): Promise<BaseResponse<T>> {
    try {
      const { current = 1, pageSize = 10, ...otherParams } = params;

      // 提取日期范围参数
      const dateStartField = `${this.defaultDateField}Start`;
      const dateEndField = `${this.defaultDateField}End`;
      const dateStart = otherParams[dateStartField];
      const dateEnd = otherParams[dateEndField];

      // 从其他参数中移除日期范围字段
      const filterParams = { ...otherParams };
      delete filterParams[dateStartField];
      delete filterParams[dateEndField];

      // 构建过滤条件
      const filters: Record<string, unknown> = {};

      // 动态处理所有过滤参数
      Object.entries(filterParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          const operator = this.operatorMap[key] || 'eq';
          filters[`${key}$${operator}`] = value;
        }
      });

      // 处理日期范围查询
      if (dateStart && dateEnd) {
        filters[`${this.defaultDateField}$between`] = [dateStart, dateEnd];
      } else if (dateStart) {
        filters[`${this.defaultDateField}$gte`] = dateStart;
      } else if (dateEnd) {
        filters[`${this.defaultDateField}$lte`] = dateEnd;
      }

      // 构建查询参数
      const queryParams = new URLSearchParams();
      queryParams.append('filters', JSON.stringify(filters));
      queryParams.append('page', current.toString());
      queryParams.append('pageSize', pageSize.toString());
      queryParams.append('orderBy', `${this.defaultDateField} desc`);

      // 发送请求
      const response = await this.http.get<PageResponse<T>>(
        `${this.apiPath}?${queryParams.toString()}`,
      );

      // 处理响应
      if (!response) {
        return { data: [], total: 0, success: false };
      }

      return {
        data: Array.isArray(response.data) ? response.data : [],
        total: response.total || 0,
        success: true,
      };
    } catch (error) {
      console.error(`获取${this.apiPath}列表失败:`, error);
      return { data: [], total: 0, success: false };
    }
  }

  /**
   * 根据ID获取单条记录
   */
  async getById(id: string): Promise<T | null> {
    try {
      // 首先尝试通过查询参数获取
      const result = await this.getAll({
        id,
        current: 1,
        pageSize: 1,
      } as unknown as Q);

      // 如果查询参数方式没有找到，尝试直接路径获取
      if (!result.data.length) {
        return await this.http.get<T>(`${this.apiPath}/${encodeURIComponent(String(id))}`);
      }

      return result.data[0] || null;
    } catch (error) {
      console.error(`获取${this.apiPath}详情失败 (ID: ${id}):`, error);
      return null;
    }
  }

  /**
   * 创建记录
   */
  async create(data: Partial<T>): Promise<T | null> {
    try {
      const cleanData = this.filterReadOnlyFields(data);
      return await this.http.post<T>(this.apiPath, cleanData);
    } catch (error) {
      console.error(`创建${this.apiPath}记录失败:`, error);
      return null;
    }
  }

  /**
   * 更新记录
   */
  async update(data: Partial<T>): Promise<T | null> {
    try {
      if (!data.id) {
        throw new Error(`更新${this.apiPath}记录需要提供ID`);
      }

      const cleanData = this.filterReadOnlyFields(data);
      return await this.http.patch<T>(`${this.apiPath}/${encodeURIComponent(String(data.id))}`, cleanData);
    } catch (error) {
      console.error(`更新${this.apiPath}记录失败:`, error);
      return null;
    }
  }

  /**
   * 删除记录
   */
  async delete(id: string): Promise<boolean> {
    try {
      await this.http.delete(`${this.apiPath}/${encodeURIComponent(String(id))}`);
      return true;
    } catch (error) {
      console.error(`删除${this.apiPath}记录失败 (ID: ${id}):`, error);
      return false;
    }
  }

  /**
   * 获取所有记录（不分页）
   * 先查询总数，然后一次性获取所有数据
   */
  async getAllNoPagination(): Promise<T[]> {
    try {
      // 先获取第一页以了解总数
      const firstPage = await this.getAll({ current: 1, pageSize: 1 } as Q);
      const total = firstPage.total;

      if (total === 0) {
        return [];
      }

      // 一次性获取所有数据
      const result = await this.getAll({ current: 1, pageSize: total } as Q);
      return result.data;
    } catch (error) {
      console.error(`获取所有${this.apiPath}数据失败:`, error);
      return [];
    }
  }
}
