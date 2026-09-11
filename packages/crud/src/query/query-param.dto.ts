import { IsOptional, IsString, IsNumber, Min, Max, IsArray } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class QueryParamDto {
  @ApiProperty({
    required: false,
    description: 'JSON格式的查询条件，例如: {"name$like":"example","age$gte":18}',
  })
  @IsOptional()
  @IsString()
  filters?: string;

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
}
