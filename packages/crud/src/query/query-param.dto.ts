import {
  IsOptional,
  IsString,
  IsNumber,
  Min,
  Max,
  IsArray,
  IsObject,
  IsBoolean,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import type { Term } from '@zucker-framework/core';

/** `filters` arrives as a JSON string (GET) or as an object (POST body). */
@ValidatorConstraint({ name: 'stringOrObject', async: false })
class StringOrObjectConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' || (typeof value === 'object' && value !== null && !Array.isArray(value));
  }

  defaultMessage(): string {
    return 'filters must be a JSON string or an object';
  }
}

/**
 * Runtime query DTO for the generated query routes (GET query strings and POST bodies). Every
 * caller-facing field of {@link DynamicQueryParam} is declared, so a whitelisting
 * `ValidationPipe` does not strip filters (which would widen the result to the whole table).
 * Field names, operators and values are validated later by the query policy.
 */
export class QueryParamDto {
  @ApiProperty({
    required: false,
    description: 'JSON格式的查询条件（GET 为字符串，POST 可为对象），例如: {"name$like":"example","age$gte":18}',
  })
  @IsOptional()
  @Validate(StringOrObjectConstraint)
  filters?: string | Record<string, unknown>;

  @ApiProperty({ required: false, type: [Object], description: '结构化 Term 条件（POST），由查询策略校验' })
  @IsOptional()
  @IsArray()
  terms?: Term[];

  @ApiProperty({ required: false, description: '排序字段，例如: "age desc, createdAt asc"' })
  @IsOptional()
  @IsString()
  orderBy?: string;

  @ApiProperty({ required: false, default: 1, minimum: 1, description: '页码' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiProperty({ required: false, default: 10, minimum: 1, maximum: 100, description: '每页条数' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  pageSize: number = 10;

  @ApiProperty({
    required: false,
    type: [String],
    description: '指定返回的字段，多个字段用逗号分隔',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value) || typeof value !== 'string') return value;
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  })
  @IsArray()
  includes?: string[];

  @ApiProperty({
    required: false,
    type: [String],
    description: '指定排除的字段，多个字段用逗号分隔',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value) || typeof value !== 'string') return value;
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  })
  @IsArray()
  excludes?: string[];

  @ApiProperty({ required: false, minimum: 0, description: '0 起始页码，优先于 page（POST _query 使用）' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  pageIndex?: number;

  @ApiProperty({ required: false, description: '结构化过滤对象，例如 {"name$like":"example"}' })
  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;

  @ApiProperty({ required: false, description: '条件表达式，例如 "status = 1 and name like \'a\'"' })
  @IsOptional()
  @IsString()
  where?: string;

  @ApiProperty({ required: false, minimum: 0, description: '前端已知总数（跳过 count 查询）' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  total?: number;

  @ApiProperty({ required: false, description: '并行执行 count 与查询' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  parallelPager?: boolean;

  @ApiProperty({ required: false, description: '先查询再推断总数' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  inferTotal?: boolean;
}
