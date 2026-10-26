import React from 'react';
import { Form, Input } from 'antd';
import type { FormRule as Rule } from 'antd';
import type { FieldDefinition } from '../types';
import { toAntdRules } from '../validators';
import { useFormMessages } from '../messages';

interface Props {
  field: FieldDefinition;
}

export function JsonField({ field }: Props) {
  const messages = useFormMessages();
  const jsonValidator: Rule = {
    validator(_, value: string) {
      if (!value) return Promise.resolve();
      try {
        JSON.parse(value);
        return Promise.resolve();
      } catch {
        return Promise.reject(new Error(messages.invalidJsonText));
      }
    },
  };
  const rules = [
    ...toAntdRules(field.validators, field.required, messages.requiredText),
    jsonValidator,
  ];

  return (
    <Form.Item name={field.key} label={field.name} rules={rules} tooltip={field.description}>
      <Input.TextArea rows={6} placeholder='{"key": "value"}' style={{ fontFamily: 'monospace' }} />
    </Form.Item>
  );
}
