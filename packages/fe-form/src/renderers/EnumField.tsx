import React, { useEffect, useState } from 'react';
import { Form, Select } from 'antd';
import type { FieldDefinition, FieldOption } from '../types';
import { toAntdRules } from '../validators';
import { useFormMessages } from '../messages';

interface Props {
  field: FieldDefinition;
  /** 可选：传入外部 HTTP 请求函数，用于加载远程字典选项 */
  fetchDictItems?: (dictCode: string) => Promise<FieldOption[]>;
}

export function EnumField({ field, fetchDictItems }: Props) {
  const messages = useFormMessages();
  const rules = toAntdRules(field.validators, field.required, messages.requiredText);
  const dictCode = field.extra?.dictCode as string | undefined;

  const [options, setOptions] = useState<FieldOption[]>(field.options ?? []);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (dictCode && fetchDictItems) {
      setLoading(true);
      fetchDictItems(dictCode)
        .then(setOptions)
        .finally(() => setLoading(false));
    }
  }, [dictCode, fetchDictItems]);

  return (
    <Form.Item name={field.key} label={field.name} rules={rules} tooltip={field.description}>
      <Select
        loading={loading}
        options={options.map((o) => ({ label: o.label, value: o.value }))}
        allowClear
        placeholder={messages.selectPlaceholder}
      />
    </Form.Item>
  );
}
