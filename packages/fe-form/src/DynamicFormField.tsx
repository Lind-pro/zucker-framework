import React from 'react';
import type { FieldDefinition, FieldOption } from './types';
import { FieldType } from './types';
import { StringField } from './renderers/StringField';
import { NumberField } from './renderers/NumberField';
import { BooleanField } from './renderers/BooleanField';
import { DateField } from './renderers/DateField';
import { EnumField } from './renderers/EnumField';
import { FileField } from './renderers/FileField';
import { JsonField } from './renderers/JsonField';
import { ArrayField } from './renderers/ArrayField';

interface Props {
  field: FieldDefinition;
  fetchDictItems?: (dictCode: string) => Promise<FieldOption[]>;
}

export function DynamicFormField({ field, fetchDictItems }: Props) {
  const type = field.type as FieldType;

  switch (type) {
    case FieldType.STRING:
      return <StringField field={field} />;
    case FieldType.NUMBER:
      return <NumberField field={field} />;
    case FieldType.BOOLEAN:
      return <BooleanField field={field} />;
    case FieldType.DATE:
    case FieldType.DATETIME:
      return <DateField field={field} />;
    case FieldType.ENUM:
      return <EnumField field={field} fetchDictItems={fetchDictItems} />;
    case FieldType.FILE:
      return <FileField field={field} />;
    case FieldType.JSON:
      return <JsonField field={field} />;
    case FieldType.ARRAY:
      return <ArrayField field={field} />;
    case FieldType.RELATION:
      // 降级为文本输入（关系目标由调用方解释）
      return <StringField field={field} />;
    default:
      return <StringField field={field} />;
  }
}
