import React from 'react';
import { Form, InputNumber } from 'antd';
import type { FieldDefinition } from '../types';
import { toAntdRules } from '../validators';

interface Props {
  field: FieldDefinition;
}

export function NumberField({ field }: Props) {
  const rules = toAntdRules(field.validators, field.required);

  return (
    <Form.Item name={field.key} label={field.name} rules={rules} tooltip={field.description}>
      <InputNumber
        style={{ width: '100%' }}
        min={field.extra?.min as number | undefined}
        max={field.extra?.max as number | undefined}
        step={field.extra?.step as number | undefined}
        precision={field.extra?.precision as number | undefined}
      />
    </Form.Item>
  );
}
