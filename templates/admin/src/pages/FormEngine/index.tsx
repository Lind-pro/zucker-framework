import { useAdminI18n } from '@/i18n';
import React, { useRef, useState, useCallback } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, Drawer, Form, Input, Modal, Table, message, Popconfirm, Space, Alert } from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, EyeOutlined, EditOutlined } from '@ant-design/icons';
import httpClient, { queryRequest } from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { DynamicForm } from '@zucker-framework/fe-form';
import type { FormDefinition, FieldDefinition } from '@zucker-framework/fe-form';
import FieldEditor from './FieldEditor';

interface FormDefRecord {
  id: string;
  name: string;
  description?: string;
  version?: number;
  createdAt: string;
  updatedAt: string;
}

const FormEnginePage: React.FC = () => {
  const { t } = useAdminI18n();
  const actionRef = useRef<ActionType>(null);
  const [previewDef, setPreviewDef] = useState<FormDefinition | null>(null);

  // Edit drawer state
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [editDef, setEditDef] = useState<FormDefinition | null>(null);
  const [editFields, setEditFields] = useState<FieldDefinition[]>([]);
  const [editForm] = Form.useForm();
  const [saving, setSaving] = useState(false), [editError, setEditError] = useState(false), [createError, setCreateError] = useState(false);

  const openEditDrawer = useCallback(async (record: FormDefRecord) => {
    try {
      const def = await httpClient.get<FormDefinition>(`/form/definition/${record.id}`);
      setEditError(false);
      setEditDef(def);
      setEditFields(def.fields ?? []);
      editForm.setFieldsValue({ name: def.name, description: def.description });
      setEditDrawerOpen(true);
    } catch {
      message.error(t("加载表单定义失败"));
    }
  }, [editForm, t]);

  const handleSaveEdit = useCallback(async () => {
    if (!editDef || saving) return;
    let values: { name: string; description?: string };
    try { values = await editForm.validateFields(); } catch { return; }
    setSaving(true); setEditError(false);
    try {
      await httpClient.put(`/form/definition/${editDef.id}`, {
        name: values.name, description: values.description ?? '', fields: editFields,
      });
      message.success(t('保存成功'));
      setEditDrawerOpen(false); actionRef.current?.reload();
    } catch { setEditError(true); }
    finally { setSaving(false); }
  }, [editDef, editFields, editForm, saving, t]);

  const handleFieldUpdate = useCallback((index: number, updated: FieldDefinition) => {
    setEditFields((prev) => {
      const next = [...prev];
      next[index] = updated;
      return next;
    });
  }, []);

  const handleFieldAdd = useCallback((field: FieldDefinition) => {
    setEditFields((prev) => [...prev, field]);
  }, []);

  const handleFieldDelete = useCallback((index: number) => {
    setEditFields((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const fieldColumns: TableColumnsType<FieldDefinition> = [
    { title: t("字段标识"), dataIndex: 'key', width: 120 },
    { title: t("显示名"), dataIndex: 'name', width: 120 },
    { title: t("类型"), dataIndex: 'type', width: 100 },
    {
      title: t("必填"),
      dataIndex: 'required',
      width: 90,
      render: (_: unknown, r: FieldDefinition) => (r.required ? t("是") : t("否")),
    },
    { title: t("描述"), dataIndex: 'description', ellipsis: true },
    {
      title: t("操作"),
      width: 120,
      render: (_: unknown, record: FieldDefinition, index: number) => (
        <Space>
          <FieldEditor
            field={record}
            trigger={<a>{t("编辑")}</a>}
            onFinish={async (values) => {
              handleFieldUpdate(index, values);
              return true;
            }}
          />
          <Popconfirm
            title={t("确定删除该字段?")}
            onConfirm={() => handleFieldDelete(index)}
          >
            <a style={{ color: '#DC2626' }}>{t("删除")}</a>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const columns: ProColumns<FormDefRecord>[] = [
    { title: t("表单名称"), dataIndex: 'name', copyable: true },
    { title: 'ID', dataIndex: 'id', copyable: true, search: false },
    { title: t("描述"), dataIndex: 'description', search: false },
    { title: t("版本"), dataIndex: 'version', search: false, width: 70 },
    { title: t("更新时间"), dataIndex: 'updatedAt', valueType: 'dateTime', search: false },
    {
      title: t("操作"),
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="preview" permission="form:query" fallback={null}>
          <Button
            type="link"
            icon={<EyeOutlined />}
            onClick={async () => {
              try {
                const def = await httpClient.get<FormDefinition>(`/form/definition/${record.id}`);
                setPreviewDef(def);
              } catch {
                message.error(t("加载表单定义失败"));
              }
            }}
          >
            {t("预览")}</Button>
        </PermissionGuard>,
        <PermissionGuard key="edit" permission="form:update" fallback={null}>
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => openEditDrawer(record)}
          >
            {t("编辑")}</Button>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="form:delete" fallback={null}>
          <Button
            type="link"
            danger
            onClick={async () => {
              try { await httpClient.delete(`/form/definition/${record.id}`); message.success(t('已删除')); actionRef.current?.reload(); }
              catch { message.error(t('删除失败，请稍后重试', 'Delete failed. Please try again.')); }
            }}
          >
            {t("删除")}</Button>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title={t("表单引擎")}>
      <ProTable<FormDefRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        request={(params) => queryRequest<FormDefRecord>('/form/definition', params)}
        toolBarRender={() => [
          <PermissionGuard key="create" permission="form:add">
            <ModalForm
              name="create-form-definition"
              submitter={{ searchConfig: { submitText: t('确认', 'Confirm'), resetText: t('取消', 'Cancel') } }}
              title={t("新建表单定义")}
              trigger={<Button type="primary" icon={<PlusOutlined />}>{t("新建表单")}</Button>}
              onOpenChange={(open) => { if (open) setCreateError(false); }}
              onFinish={async (values) => {
                setCreateError(false);
                try { await httpClient.post('/form/definition', { ...values, fields: [] }); message.success(t('创建成功')); actionRef.current?.reload(); return true; }
                catch { setCreateError(true); return false; }
              }}
            >
              {createError && <Alert type="error" showIcon message={t('创建失败，填写内容已保留，请重试', 'Create failed. Your entries are preserved; please retry.')} style={{ marginBottom: 16 }} />}
              <ProFormText name="name" label={t("表单名称")} rules={[{ required: true }]} />
              <ProFormTextArea name="description" label={t("描述")} />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />

      {/* Preview Modal */}
      <Modal
        open={!!previewDef}
        title={t('预览：{name}', 'Preview: {name}', { name: previewDef?.name ?? '' })}
        footer={null}
        onCancel={() => setPreviewDef(null)}
        width={700}
        destroyOnClose
      >
        {previewDef && (
          <DynamicForm
            definition={previewDef}
            messages={{
              submitText: t('提交', 'Submit'),
              loadingText: t('加载表单中...', 'Loading form...'),
              loadFailedText: t('加载表单失败：', 'Failed to load form: '),
              requiredText: t('该字段为必填项', 'This field is required'),
              selectPlaceholder: t('请选择', 'Please select'),
              invalidJsonText: t('请输入合法的 JSON 格式', 'Enter valid JSON'),
              chooseFileText: t('选择文件', 'Choose file'),
            }}
            onFinish={async () => {
              message.info(t("预览模式，不实际提交"));
            }}
            submitText={t("预览提交")}
          />
        )}
      </Modal>

      {/* Edit Drawer */}
      <Drawer
        title={t("编辑表单定义")}
        width={720}
        open={editDrawerOpen}
        onClose={() => setEditDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setEditDrawerOpen(false)}>{t("取消")}</Button>
            <Button type="primary" loading={saving} onClick={handleSaveEdit}>
              {t("保存")}</Button>
          </Space>
        }
      >
        {editDef && (
          <>
            {editError && <Alert type="error" showIcon message={t('保存失败，编辑内容已保留，请重试保存', 'Save failed. Your edits are preserved; please retry saving.')} style={{ marginBottom: 16 }} />}
            <Form name="edit-form-definition" form={editForm} layout="vertical" style={{ marginBottom: 24 }}>
              <Form.Item
                name="name"
                label={t("表单名称")}
                rules={[{ required: true, message: t("请输入表单名称") }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="description" label={t("描述")}>
                <Input.TextArea rows={2} />
              </Form.Item>
            </Form>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h4 style={{ margin: 0 }}>{t("字段列表")}</h4>
              <FieldEditor
                trigger={
                  <Button type="primary" size="small" icon={<PlusOutlined />}>
                    {t("添加字段")}</Button>
                }
                onFinish={async (values) => {
                  handleFieldAdd(values);
                  return true;
                }}
              />
            </div>

            <Table<FieldDefinition>
              rowKey="key"
              dataSource={editFields}
              columns={fieldColumns}
              pagination={false}
              size="small"
            />
          </>
        )}
      </Drawer>
    </PageContainer>
  );
};

export default FormEnginePage;
