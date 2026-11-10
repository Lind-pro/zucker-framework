import { useMemo, useState } from 'react';
import { Form, Button, Spin, Alert, Row, Col } from 'antd';
import type { FormDefinition, FieldOption } from './types';
import { DynamicFormField } from './DynamicFormField';
import { useFormDefinition, type FormDefinitionFetcher } from './useFormDefinition';
import { definitionInitialValues, normalizeFormValues, type FormFileUploader } from './values';
import {
  FormMessagesContext,
  resolveFormMessages,
  useFormMessages,
  type DynamicFormMessages,
} from './messages';

export interface DynamicFormProps {
  /** 从 API 加载表单定义（与 definition 二选一）*/
  formId?: string;
  /** 直接传入表单定义（与 formId 二选一）*/
  definition?: FormDefinition;
  /**
   * Authenticated GET used with `formId` (the definition endpoint requires a signed-in user with
   * `form:query`). It receives `{definitionBasePath}/form/definition/<encoded id>` and may resolve the
   * definition or the framework response envelope. Defaults to a same-origin `fetch`.
   */
  httpGet?: FormDefinitionFetcher;
  /** Prefix for the definition URL used with `formId`. Defaults to `/api`. */
  definitionBasePath?: string;
  initialValues?: Record<string, unknown>;
  /**
   * Receives values normalised to the server's field shapes: JSON → object, ARRAY → array,
   * DATE → `YYYY-MM-DD`, DATETIME → ISO string, FILE → `uploadFile` results (or raw `File`s when no
   * uploader is given).
   */
  onFinish: (values: Record<string, unknown>) => Promise<void>;
  layout?: 'vertical' | 'horizontal' | 'inline';
  submitText?: string;
  /** Instance-local interface translations; omitted messages retain the existing defaults. */
  messages?: Partial<DynamicFormMessages>;
  /** 加载远程字典选项（ENUM 字段 extra.dictCode 存在时使用）*/
  fetchDictItems?: (dictCode: string) => Promise<FieldOption[]>;
  /** Uploads each newly chosen FILE value at submit time and returns the value to store. */
  uploadFile?: FormFileUploader;
}

/** 1..24 columns; anything else falls back to a single column. */
function columnSpan(columns: unknown): number {
  const count = typeof columns === 'number' && Number.isInteger(columns) && columns >= 1 ? Math.min(columns, 24) : 1;
  return Math.floor(24 / count);
}

function FormContent({
  definition,
  initialValues,
  onFinish,
  layout,
  submitText,
  fetchDictItems,
  uploadFile,
}: Omit<DynamicFormProps, 'formId' | 'messages' | 'httpGet' | 'definitionBasePath'> & { definition: FormDefinition }) {
  const [form] = Form.useForm();
  const messages = useFormMessages();
  const [submitting, setSubmitting] = useState(false);
  const span = columnSpan(definition.layout?.columns);
  const position = definition.layout?.labelPosition;
  const resolvedLayout = layout ?? (position === 'left' || position === 'right' ? 'horizontal' : 'vertical');
  const labelAlign = definition.layout?.labelAlign ?? (position === 'left' ? 'left' : 'right');
  const labelWidth = definition.layout?.labelWidth;
  const initial = useMemo(() => definitionInitialValues(definition, initialValues), [definition, initialValues]);

  const submit = async (values: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      await onFinish(await normalizeFormValues(definition, values, uploadFile));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Form
      form={form}
      layout={resolvedLayout}
      initialValues={initial}
      onFinish={submit as (values: unknown) => void}
      labelAlign={labelAlign}
      labelCol={resolvedLayout === 'horizontal' && labelWidth !== undefined ? { flex: typeof labelWidth === 'number' ? `${labelWidth}px` : labelWidth } : undefined}
    >
      <Row gutter={16}>
        {definition.fields.map((field) => (
          <Col key={field.key} span={span}>
            <DynamicFormField field={field} fetchDictItems={fetchDictItems} />
          </Col>
        ))}
      </Row>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting}>
          {submitText ?? messages.submitText}
        </Button>
      </Form.Item>
    </Form>
  );
}

export function DynamicForm(props: DynamicFormProps) {
  const { formId, definition: propDefinition, messages: overrides, httpGet, definitionBasePath, ...rest } = props;
  const messages = resolveFormMessages(overrides);

  // A directly supplied definition wins; the remote one is only requested when none was given.
  const { definition: loadedDefinition, loading, error } = useFormDefinition(
    propDefinition ? undefined : formId,
    httpGet,
    { basePath: definitionBasePath },
  );
  const definition = propDefinition ?? loadedDefinition;

  if (loading) {
    return <Spin description={messages.loadingText} />;
  }

  if (error) {
    return <Alert type="error" title={`${messages.loadFailedText}${error}`} />;
  }

  if (!definition) {
    return null;
  }

  return (
    <FormMessagesContext.Provider value={messages}>
      <FormContent definition={definition} {...rest} />
    </FormMessagesContext.Provider>
  );
}
