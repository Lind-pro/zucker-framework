import React from 'react';
import { Form, InputNumber } from 'antd';
import type { FieldDefinition } from '../types';
import { toAntdRules } from '../validators';
import { useFormMessages } from '../messages';

interface Props {
  field: FieldDefinition;
}

export function NumberField({ field }: Props) {
  const messages = useFormMessages();
  const rules = toAntdRules(field.validators, field.required, messages.requiredText);

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
