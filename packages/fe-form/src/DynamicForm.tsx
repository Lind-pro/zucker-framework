import { Form, Button, Spin, Alert, Row, Col } from 'antd';
import type { FormDefinition, FieldOption } from './types';
import { DynamicFormField } from './DynamicFormField';
import { useFormDefinition } from './useFormDefinition';

export interface DynamicFormProps {
  /** 从 API 加载表单定义（与 definition 二选一）*/
  formId?: string;
  /** 直接传入表单定义（与 formId 二选一）*/
  definition?: FormDefinition;
  initialValues?: Record<string, unknown>;
  onFinish: (values: Record<string, unknown>) => Promise<void>;
  layout?: 'vertical' | 'horizontal' | 'inline';
  submitText?: string;
  /** 加载远程字典选项（ENUM 字段 extra.dictCode 存在时使用）*/
  fetchDictItems?: (dictCode: string) => Promise<FieldOption[]>;
}

function FormContent({
  definition,
  initialValues,
  onFinish,
  layout = 'vertical',
  submitText = '提交',
  fetchDictItems,
}: Omit<DynamicFormProps, 'formId'> & { definition: FormDefinition }) {
  const [form] = Form.useForm();
  const columns = definition.layout?.columns ?? 1;

  return (
    <Form
      form={form}
      layout={layout}
      initialValues={initialValues}
      onFinish={onFinish as (values: unknown) => void}
      labelAlign={definition.layout?.labelAlign ?? 'right'}
    >
      <Row gutter={16}>
        {definition.fields.map((field) => (
          <Col key={field.key} span={Math.floor(24 / columns)}>
            <DynamicFormField field={field} fetchDictItems={fetchDictItems} />
          </Col>
        ))}
      </Row>
      <Form.Item>
        <Button type="primary" htmlType="submit">
          {submitText}
        </Button>
      </Form.Item>
    </Form>
  );
}

export function DynamicForm(props: DynamicFormProps) {
  const { formId, definition: propDefinition, ...rest } = props;

  const { definition: loadedDefinition, loading, error } = useFormDefinition(formId);
  const definition = propDefinition ?? loadedDefinition;

  if (loading) {
    return <Spin description="加载表单中..." />;
  }

  if (error) {
    return <Alert type="error" title={`加载表单失败：${error}`} />;
  }

  if (!definition) {
    return null;
  }

  return <FormContent definition={definition} {...rest} />;
}
