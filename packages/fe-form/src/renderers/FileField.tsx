import React from 'react';
import { Form, Upload, Button } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { FieldDefinition } from '../types';
import { toAntdRules } from '../validators';

interface Props {
  field: FieldDefinition;
}

export function FileField({ field }: Props) {
  const rules = toAntdRules(field.validators, field.required);
  const accept = field.extra?.accept as string | undefined;
  const maxCount = (field.extra?.maxCount as number) ?? 1;

  return (
    <Form.Item
      name={field.key}
      label={field.name}
      rules={rules}
      tooltip={field.description}
      valuePropName="fileList"
      getValueFromEvent={(e) => (Array.isArray(e) ? e : e?.fileList)}
    >
      <Upload accept={accept} maxCount={maxCount} beforeUpload={() => false}>
        <Button icon={<UploadOutlined />}>选择文件</Button>
      </Upload>
    </Form.Item>
  );
}
