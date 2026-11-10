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

  const [remote, setRemote] = useState<{ code: string; options: FieldOption[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!dictCode || !fetchDictItems) return;
    let active = true;
    setLoading(true);
    setFailed(false);
    Promise.resolve()
      .then(() => fetchDictItems(dictCode))
      .then((items) => {
        if (active) setRemote({ code: dictCode, options: Array.isArray(items) ? items : [] });
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dictCode, fetchDictItems]);

  // Remote options apply only to the dictionary they were loaded for; otherwise follow field.options.
  const options = remote && remote.code === dictCode ? remote.options : (field.options ?? []);

  return (
    <Form.Item
      name={field.key}
      label={field.name}
      rules={rules}
      tooltip={field.description}
      validateStatus={failed ? 'warning' : undefined}
      help={failed ? messages.optionsLoadFailedText : undefined}
    >
      <Select
        loading={loading}
        options={options.map((o) => ({ label: o.label, value: o.value }))}
        allowClear
        placeholder={messages.selectPlaceholder}
      />
    </Form.Item>
  );
}
