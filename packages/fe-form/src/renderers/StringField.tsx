import React from 'react';
import { Form, Input } from 'antd';
import type { FieldDefinition } from '../types';
import { toAntdRules } from '../validators';

interface Props {
  field: FieldDefinition;
}

export function StringField({ field }: Props) {
  const multiline = field.extra?.multiline === true;
  const rules = toAntdRules(field.validators, field.required);

  return (
    <Form.Item name={field.key} label={field.name} rules={rules} tooltip={field.description}>
      {multiline ? (
        <Input.TextArea
          rows={(field.extra?.rows as number) || 4}
          placeholder={field.extra?.placeholder as string | undefined}
        />
      ) : (
        <Input placeholder={field.extra?.placeholder as string | undefined} />
      )}
    </Form.Item>
  );
}
