import React from 'react';
import { Form, Input } from 'antd';
import type { Rule } from 'antd/es/form';
import type { FieldDefinition } from '../types';
import { toAntdRules } from '../validators';

interface Props {
  field: FieldDefinition;
}

const jsonValidator: Rule = {
  validator(_, value: string) {
    if (!value) return Promise.resolve();
    try {
      JSON.parse(value);
      return Promise.resolve();
    } catch {
      return Promise.reject(new Error('请输入合法的 JSON 格式'));
    }
  },
};

export function JsonField({ field }: Props) {
  const rules = [...toAntdRules(field.validators, field.required), jsonValidator];

  return (
    <Form.Item name={field.key} label={field.name} rules={rules} tooltip={field.description}>
      <Input.TextArea rows={6} placeholder='{"key": "value"}' style={{ fontFamily: 'monospace' }} />
    </Form.Item>
  );
}
