/**
 * 物模型数据类型系统 — 对应 jetlinks DataType / DataTypes
 *
 * 描述属性、事件参数、功能参数的值类型。
 */

export type DataTypeId =
  | 'string'
  | 'int'
  | 'long'
  | 'float'
  | 'double'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'object'
  | 'array'
  | 'geo'
  | 'password'
  | 'file';

/**
 * 枚举元素 — 对应 jetlinks EnumType.Element
 */
export interface EnumElement {
  value: string | number;
  text: string;
  description?: string;
}

/**
 * 地理坐标 — 对应 jetlinks GeoType
 */
export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface BaseDataType {
  id: DataTypeId;
  description?: string;
}

export interface StringDataType extends BaseDataType {
  id: 'string';
  maxLength?: number;
  unit?: string;
}

export interface IntDataType extends BaseDataType {
  id: 'int';
  max?: number;
  min?: number;
  unit?: string;
}

export interface LongDataType extends BaseDataType {
  id: 'long';
  max?: number;
  min?: number;
  unit?: string;
}

export interface FloatDataType extends BaseDataType {
  id: 'float';
  max?: number;
  min?: number;
  unit?: string;
  scale?: number;
}

export interface DoubleDataType extends BaseDataType {
  id: 'double';
  max?: number;
  min?: number;
  unit?: string;
  scale?: number;
}

export interface BooleanDataType extends BaseDataType {
  id: 'boolean';
  trueText?: string;
  falseText?: string;
  trueValue?: string;
  falseValue?: string;
}

export interface EnumDataType extends BaseDataType {
  id: 'enum';
  elements: EnumElement[];
}

export interface DateDataType extends BaseDataType {
  id: 'date';
  /** 日期格式，默认 'yyyy-MM-dd HH:mm:ss' */
  format?: string;
  timeZone?: string;
}

export interface ObjectDataType extends BaseDataType {
  id: 'object';
  properties?: PropertyMetadataInput[];
}

export interface ArrayDataType extends BaseDataType {
  id: 'array';
  elementType: DataType;
}

export interface GeoDataType extends BaseDataType {
  id: 'geo';
}

export interface PasswordDataType extends BaseDataType {
  id: 'password';
}

export interface FileDataType extends BaseDataType {
  id: 'file';
  bodyType?: 'url' | 'base64' | 'binary';
}

export type DataType =
  | StringDataType
  | IntDataType
  | LongDataType
  | FloatDataType
  | DoubleDataType
  | BooleanDataType
  | EnumDataType
  | DateDataType
  | ObjectDataType
  | ArrayDataType
  | GeoDataType
  | PasswordDataType
  | FileDataType;

/** 属性元数据输入（用于 ObjectDataType.properties，不能自引用完整类型） */
export interface PropertyMetadataInput {
  id: string;
  name: string;
  dataType: DataType;
  description?: string;
}

/**
 * 将原始值转换为对应数据类型的 JavaScript 表示 — 对应 jetlinks DataType.convert()
 */
export function convertValue(type: DataType, raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;

  switch (type.id) {
    case 'int':
    case 'long': {
      const n = Number(raw);
      return isNaN(n) ? raw : Math.trunc(n);
    }
    case 'float':
    case 'double': {
      const n = Number(raw);
      if (isNaN(n)) return raw;
      if (type.scale !== undefined) {
        return parseFloat(n.toFixed(type.scale));
      }
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const tv = type.trueValue ?? 'true';
      const fv = type.falseValue ?? 'false';
      if (String(raw) === tv) return true;
      if (String(raw) === fv) return false;
      return Boolean(raw);
    }
    case 'string':
    case 'password':
      return String(raw);
    case 'date': {
      if (raw instanceof Date) return raw.getTime();
      const n = Number(raw);
      return isNaN(n) ? new Date(String(raw)).getTime() : n;
    }
    case 'enum': {
      const match = type.elements.find(
        (e) => e.value === raw || String(e.value) === String(raw),
      );
      return match ? match.value : raw;
    }
    default:
      return raw;
  }
}
