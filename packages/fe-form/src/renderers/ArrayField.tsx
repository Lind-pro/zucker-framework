import React from 'react';
import { Form, Select } from 'antd';
import type { FieldDefinition } from '../types';
import { toAntdRules } from '../validators';
import { useFormMessages } from '../messages';

interface Props {
  field: FieldDefinition;
}

/** ARRAY fields are edited as a tag list so the submitted value is an array, as the server requires. */
export function ArrayField({ field }: Props) {
  const messages = useFormMessages();
  const rules = toAntdRules(field.validators, field.required, messages.requiredText);

  return (
    <Form.Item name={field.key} label={field.name} rules={rules} tooltip={field.description}>
      <Select
        mode="tags"
        allowClear
        tokenSeparators={[',']}
        options={(field.options ?? []).map((o) => ({ label: o.label, value: String(o.value) }))}
        placeholder={field.extra?.placeholder as string | undefined}
      />
    </Form.Item>
  );
}
