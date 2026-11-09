import {
  Button,
  DataTable,
  DeleteAction,
  Dialog,
  Drawer,
  Field,
  FormDialog,
  Input,
  Notice,
  PageContainer,
  ResourceTable,
  Select,
  Textarea,
  crudLoader,
  formatDateTime,
  toast,
  useAdminApi,
  useAdminI18n,
  usePermissionCheck,
  type ResourceTableHandle,
} from '@zucker-framework/fe-admin';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useText } from '../text';

/** Field definition stored by the server's form module (`/form/definition`). */
interface FieldDefinition {
  key: string;
  name: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'enum' | 'json' | 'array';
  required?: boolean;
  defaultValue?: unknown;
  description?: string;
  options?: Array<{ label: string; value: string | number }>;
  [extra: string]: unknown;
}
interface FormDefinition {
  id: string;
  name: string;
  description?: string;
  version?: number;
  fields?: FieldDefinition[];
  updatedAt?: string;
}
const FIELD_TYPES: FieldDefinition['type'][] = ['string', 'number', 'date', 'boolean', 'enum', 'json', 'array'];

function FieldEditor({ field, existingKeys, onClose, onSave }: { field: FieldDefinition | null; existingKeys: string[]; onClose: () => void; onSave: (field: FieldDefinition) => void }) {
  const tx = useText();
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={field ? tx('编辑字段', 'Edit field') : tx('新建字段', 'New field')}
      initialValues={{
        key: field?.key ?? '',
        name: field?.name ?? '',
        type: field?.type ?? 'string',
        required: field?.required ?? false,
        defaultValue: field?.defaultValue == null ? '' : String(field.defaultValue),
        description: field?.description ?? '',
        options: (field?.options ?? []).map((option) => `${option.label}=${option.value}`).join('\n'),
      }}
      fields={[
        { name: 'key', label: tx('字段标识', 'Key'), required: true, disabled: Boolean(field), description: tx('创建后不可修改', 'Cannot be changed later') },
        { name: 'name', label: tx('显示名', 'Label'), required: true },
        { name: 'type', label: tx('类型', 'Type'), type: 'select', required: true, options: FIELD_TYPES.map((type) => ({ value: type, label: type })) },
        { name: 'required', label: tx('是否必填', 'Required'), type: 'switch' },
        { name: 'defaultValue', label: tx('默认值', 'Default value') },
        { name: 'description', label: tx('描述', 'Description'), type: 'textarea' },
        { name: 'options', label: tx('枚举选项（每行 标签=值）', 'Enum options (one label=value per line)'), type: 'textarea', rows: 4 },
      ]}
      validate={(values) => (!field && existingKeys.includes(String(values.key).trim()) ? { key: tx('字段标识已存在', 'Key already exists') } : {})}
      onSubmit={(values) => {
        const result: FieldDefinition = {
          ...field,
          key: String(values.key).trim(),
          name: String(values.name).trim(),
          type: values.type as FieldDefinition['type'],
          required: values.required === true,
          defaultValue: values.defaultValue === '' ? undefined : values.defaultValue,
          description: String(values.description ?? ''),
        };
        if (result.type === 'enum')
          result.options = String(values.options ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [label, ...rest] = line.split('=');
              return { label: (label ?? '').trim(), value: (rest.join('=') || label || '').trim() };
            });
        else delete result.options;
        onSave(result);
      }}
    />
  );
}

/** Read-only preview rendered with native controls; nothing is submitted. */
function Preview({ definition, onClose }: { definition: FormDefinition; onClose: () => void }) {
  const tx = useText();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} width={700} title={tx(`预览：${definition.name}`, `Preview: ${definition.name}`)}>
      <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
        <Notice tone="info" title={tx('预览模式，不实际提交', 'Preview only; nothing is submitted')} />
        {(definition.fields ?? []).map((field) => (
          <Field key={field.key} label={field.name} required={field.required} description={field.description}>
            {({ id }) =>
              field.type === 'enum' ? (
                <Select id={id} placeholder={tx('请选择', 'Select')} options={(field.options ?? []).map((option) => ({ value: String(option.value), label: option.label }))} />
              ) : field.type === 'boolean' ? (
                <input id={id} type="checkbox" className="size-4" />
              ) : field.type === 'json' || field.type === 'array' ? (
                <Textarea id={id} rows={3} defaultValue={field.defaultValue == null ? '' : String(field.defaultValue)} />
              ) : (
                <Input
                  id={id}
                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                  defaultValue={field.defaultValue == null ? '' : String(field.defaultValue)}
                />
              )
            }
          </Field>
        ))}
      </form>
    </Dialog>
  );
}

function DefinitionEditor({ definition, onClose, onSaved }: { definition: FormDefinition; onClose: () => void; onSaved: () => void }) {
  const api = useAdminApi();
  const tx = useText();
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description ?? '');
  const [fields, setFields] = useState<FieldDefinition[]>(definition.fields ?? []);
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setFailed(false);
    try {
      await api.put(`/form/definition/${encodeURIComponent(definition.id)}`, { name: name.trim(), description, fields });
      toast.success(tx('保存成功', 'Saved'));
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Drawer
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      width={760}
      title={tx('编辑表单定义', 'Edit form definition')}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={!name.trim()} onClick={() => void save()}>
            {tx('保存', 'Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failed && <Notice tone="danger" title={tx('保存失败，编辑内容已保留，请重试保存', 'Save failed; your edits are kept. Retry.')} />}
        <Field label={tx('表单名称', 'Form name')} required>
          {({ id }) => <Input id={id} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label={tx('描述', 'Description')}>
          {({ id }) => <Textarea id={id} rows={2} value={description} disabled={saving} onChange={(event) => setDescription(event.target.value)} />}
        </Field>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{tx('字段列表', 'Fields')}</h3>
          <Button size="sm" variant="primary" icon={<Plus />} disabled={saving} onClick={() => setEditing({ index: null })}>
            {tx('添加字段', 'Add field')}
          </Button>
        </div>
        <DataTable<FieldDefinition & { index: number }>
          label={tx('字段列表', 'Fields')}
          rows={fields.map((field, index) => ({ ...field, index }))}
          rowKey={(row) => row.key}
          columns={[
            { key: 'key', title: tx('字段标识', 'Key'), field: 'key' },
            { key: 'name', title: tx('显示名', 'Label'), field: 'name' },
            { key: 'type', title: tx('类型', 'Type'), field: 'type' },
            { key: 'required', title: tx('必填', 'Required'), render: (row) => (row.required ? tx('是', 'Yes') : tx('否', 'No')) },
          ]}
          actions={(row) => (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing({ index: row.index })}>
                {tx('编辑', 'Edit')}
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setFields((previous) => previous.filter((_, index) => index !== row.index))}>
                {tx('删除', 'Delete')}
              </Button>
            </>
          )}
        />
      </div>
      {editing && (
        <FieldEditor
          field={editing.index === null ? null : (fields[editing.index] ?? null)}
          existingKeys={fields.map((field) => field.key)}
          onClose={() => setEditing(null)}
          onSave={(field) =>
            setFields((previous) =>
              editing.index === null ? [...previous, field] : previous.map((item, index) => (index === editing.index ? field : item)),
            )
          }
        />
      )}
    </Drawer>
  );
}

/** Dynamic form definitions (`/form/definition`). */
export function FormEnginePage() {
  const api = useAdminApi();
  const { locale } = useAdminI18n();
  const tx = useText();
  const can = usePermissionCheck();
  const table = useRef<ResourceTableHandle>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FormDefinition | null>(null);
  const [previewing, setPreviewing] = useState<FormDefinition | null>(null);
  const load = async (id: string) => {
    try {
      return await api.get<FormDefinition>(`/form/definition/${encodeURIComponent(id)}`);
    } catch {
      toast.error(tx('加载表单定义失败', 'Could not load the form definition'));
      return null;
    }
  };
  return (
    <PageContainer
      title={tx('表单引擎', 'Form engine')}
      actions={
        can('form:add') && (
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            {tx('新建表单', 'New form')}
          </Button>
        )
      }
    >
      <ResourceTable<FormDefinition>
        ref={table}
        label={tx('表单定义', 'Form definitions')}
        load={crudLoader(api, '/form/definition', (filters) => (filters.name ? { name$like: filters.name } : {}))}
        rowKey={(row) => row.id}
        filters={[{ name: 'name', label: tx('表单名称', 'Form name') }]}
        columns={[
          { key: 'name', title: tx('表单名称', 'Form name'), field: 'name' },
          { key: 'id', title: 'ID', field: 'id', hideOnMobile: true },
          { key: 'description', title: tx('描述', 'Description'), field: 'description', hideOnMobile: true },
          { key: 'version', title: tx('版本', 'Version'), field: 'version' },
          { key: 'updatedAt', title: tx('更新时间', 'Updated'), render: (row) => formatDateTime(row.updatedAt, locale) },
        ]}
        actions={(row) => (
          <>
            <Button size="sm" variant="ghost" onClick={async () => setPreviewing(await load(row.id))}>
              {tx('预览', 'Preview')}
            </Button>
            {can('form:update') && (
              <Button size="sm" variant="ghost" onClick={async () => setEditing(await load(row.id))}>
                {tx('编辑', 'Edit')}
              </Button>
            )}
            {can('form:delete') && (
              <DeleteAction
                onDelete={async () => {
                  await api.delete(`/form/definition/${encodeURIComponent(row.id)}`);
                  table.current?.reload();
                }}
              />
            )}
          </>
        )}
      />
      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title={tx('新建表单定义', 'New form definition')}
        failureMessage={tx('创建失败，填写内容已保留，请重试', 'Create failed; your entries are kept. Retry.')}
        initialValues={{ name: '', description: '' }}
        fields={[
          { name: 'name', label: tx('表单名称', 'Form name'), required: true },
          { name: 'description', label: tx('描述', 'Description'), type: 'textarea' },
        ]}
        onSubmit={async (values) => {
          await api.post('/form/definition', { ...values, fields: [] });
          toast.success(tx('创建成功', 'Created'));
          table.current?.reload();
        }}
      />
      {editing && (
        <DefinitionEditor
          key={editing.id}
          definition={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            table.current?.reload();
          }}
        />
      )}
      {previewing && <Preview definition={previewing} onClose={() => setPreviewing(null)} />}
    </PageContainer>
  );
}
