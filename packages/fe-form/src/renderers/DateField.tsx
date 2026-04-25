import React from 'react';
import { Form, DatePicker } from 'antd';
import type { FieldDefinition } from '../types';
import { FieldType } from '../types';
import { toAntdRules } from '../validators';

interface Props {
  field: FieldDefinition;
}

export function DateField({ field }: Props) {
  const rules = toAntdRules(field.validators, field.required);
  const showTime = field.type === FieldType.DATETIME;

  return (
    <Form.Item name={field.key} label={field.name} rules={rules} tooltip={field.description}>
      <DatePicker
        style={{ width: '100%' }}
        showTime={showTime}
        format={showTime ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD'}
      />
    </Form.Item>
  );
}
