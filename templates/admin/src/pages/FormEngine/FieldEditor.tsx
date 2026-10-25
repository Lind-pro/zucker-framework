import { useAdminI18n } from '@/i18n';
import React from 'react';
import {
  ModalForm,
  ProFormText,
  ProFormTextArea,
  ProFormSelect,
  ProFormSwitch,
} from '@ant-design/pro-components';
import { Button, Form, Input, Space } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import type { FieldDefinition } from '@zucker-framework/fe-form';

const FIELD_TYPE_OPTIONS = [
  { label: '文本 (STRING)', value: 'string' },
  { label: '数字 (NUMBER)', value: 'number' },
  { label: '日期 (DATE)', value: 'date' },
  { label: '布尔 (BOOLEAN)', value: 'boolean' },
  { label: '枚举 (ENUM)', value: 'enum' },
  { label: 'JSON', value: 'json' },
  { label: '数组 (ARRAY)', value: 'array' },
];

interface FieldEditorProps {
  field?: FieldDefinition;
  trigger: React.JSX.Element;
  onFinish: (values: FieldDefinition) => Promise<boolean>;
  title?: string;
}

const FieldEditor: React.FC<FieldEditorProps> = ({ field, trigger, onFinish, title }) => {
  const { t } = useAdminI18n();
  const formId = React.useId();
  return (
    <ModalForm<FieldDefinition & { options?: Array<{ label: string; value: string | number }> }>
      name={`field-editor-${formId}`}
      submitter={{ searchConfig: { submitText: t('确认', 'Confirm'), resetText: t('取消', 'Cancel') } }}
      title={title ?? (field ? t("编辑字段") : t("新建字段"))}
      trigger={trigger}
      initialValues={
        field
          ? {
              key: field.key,
              name: field.name,
              type: field.type,
              required: field.required ?? false,
              defaultValue: field.defaultValue != null ? String(field.defaultValue) : undefined,
              description: field.description,
              options: field.options,
            }
          : { required: false }
      }
      modalProps={{ destroyOnClose: true }}
      onFinish={async (values) => {
        const result: FieldDefinition = {
          ...field,
          key: values.key,
          name: values.name,
          type: values.type,
          required: values.required,
          defaultValue: values.defaultValue,
          description: values.description,
        };
        if (values.type === 'enum' && values.options) {
          result.options = values.options;
        }
        return onFinish(result);
      }}
    >
      <ProFormText
        name="key"
        label={t("字段标识")}
        rules={[{ required: true, message: t("请输入字段标识") }]}
        disabled={!!field}
        tooltip={t("字段的唯一标识，创建后不可修改")}
      />
      <ProFormText
        name="name"
        label={t("显示名")}
        rules={[{ required: true, message: t("请输入显示名") }]}
      />
      <ProFormSelect
        name="type"
        label={t("类型")}
        rules={[{ required: true, message: t("请选择类型") }]}
        options={FIELD_TYPE_OPTIONS.map(option => ({ ...option, label: t(option.label) }))}
      />
      <ProFormSwitch name="required" label={t("是否必填")} />
      <ProFormText name="defaultValue" label={t("默认值")} />
      <ProFormTextArea name="description" label={t("描述")} />

      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>
        {({ getFieldValue }) =>
          getFieldValue('type') === 'enum' ? (
            <Form.Item label={t("枚举选项")}>
              <Form.List name="options">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name, ...restField }) => (
                      <Space key={key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                        <Form.Item
                          {...restField}
                          name={[name, 'label']}
                          rules={[{ required: true, message: t("请输入标签") }]}
                          style={{ marginBottom: 0 }}
                        >
                          <Input placeholder={t("标签")} />
                        </Form.Item>
                        <Form.Item
                          {...restField}
                          name={[name, 'value']}
                          rules={[{ required: true, message: t("请输入值") }]}
                          style={{ marginBottom: 0 }}
                        >
                          <Input placeholder={t("值")} />
                        </Form.Item>
                        <MinusCircleOutlined onClick={() => remove(name)} />
                      </Space>
                    ))}
                    <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                      {t("添加选项")}</Button>
                  </>
                )}
              </Form.List>
            </Form.Item>
          ) : null
        }
      </Form.Item>
    </ModalForm>
  );
};

export default FieldEditor;
