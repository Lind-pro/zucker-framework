import React from 'react';
import { Form, Switch } from 'antd';
import type { FieldDefinition } from '../types';

interface Props {
  field: FieldDefinition;
}

export function BooleanField({ field }: Props) {
  return (
    <Form.Item
      name={field.key}
      label={field.name}
      tooltip={field.description}
      valuePropName="checked"
    >
      <Switch />
    </Form.Item>
  );
}
