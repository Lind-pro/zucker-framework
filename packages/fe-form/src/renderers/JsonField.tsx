import React from 'react';
import { Form, Input } from 'antd';
import type { FormRule as Rule } from 'antd';
import type { FieldDefinition } from '../types';
import { toAntdRules } from '../validators';
import { useFormMessages } from '../messages';
import { parseJsonFieldText } from '../values';

interface Props {
  field: FieldDefinition;
}

export function JsonField({ field }: Props) {
  const messages = useFormMessages();
  const jsonValidator: Rule = {
    validator(_, value: string) {
      if (!value || !value.trim()) return Promise.resolve();
      // Objects and arrays only: a bare `123` or `"x"` would fail the server's JSON check.
      return parseJsonFieldText(value).ok
        ? Promise.resolve()
        : Promise.reject(new Error(messages.invalidJsonText));
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
