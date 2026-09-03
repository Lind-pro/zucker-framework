import React, { useRef, useState, useCallback } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, Drawer, Form, Input, Modal, Table, message, Popconfirm, Space } from 'antd';
import { PlusOutlined, EyeOutlined, EditOutlined } from '@ant-design/icons';
import httpClient, { queryRequest } from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { DynamicForm } from '@zucker/fe-form';
import type { FormDefinition, FieldDefinition } from '@zucker/fe-form';
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
  const actionRef = useRef<ActionType>(null);
  const [previewDef, setPreviewDef] = useState<FormDefinition | null>(null);

  // Edit drawer state
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [editDef, setEditDef] = useState<FormDefinition | null>(null);
  const [editFields, setEditFields] = useState<FieldDefinition[]>([]);
  const [editForm] = Form.useForm();

  const openEditDrawer = useCallback(async (record: FormDefRecord) => {
    try {
      const def = await httpClient.get<FormDefinition>(`/form/definition/${record.id}`);
      setEditDef(def);
      setEditFields(def.fields ?? []);
      editForm.setFieldsValue({ name: def.name, description: def.description });
      setEditDrawerOpen(true);
    } catch {
      message.error('加载表单定义失败');
    }
  }, [editForm]);

  const handleSaveEdit = useCallback(async () => {
    if (!editDef) return;
    try {
      const values = await editForm.validateFields();
      await httpClient.put(`/form/definition/${editDef.id}`, {
        ...editDef,
        name: values.name,
        description: values.description,
        fields: editFields,
      });
      message.success('保存成功');
      setEditDrawerOpen(false);
      actionRef.current?.reload();
    } catch {
      // form validation error or network error — no-op, antd shows validation
    }
  }, [editDef, editFields, editForm]);

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

  const fieldColumns: Array<Record<string, unknown>> = [
    { title: '字段标识', dataIndex: 'key', width: 120 },
    { title: '显示名', dataIndex: 'name', width: 120 },
    { title: '类型', dataIndex: 'type', width: 100 },
    {
      title: '必填',
      dataIndex: 'required',
      width: 60,
      render: (_: unknown, r: FieldDefinition) => (r.required ? '是' : '否'),
    },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '操作',
      width: 120,
      render: (_: unknown, record: FieldDefinition, index: number) => (
        <Space>
          <FieldEditor
            field={record}
            trigger={<a>编辑</a>}
            onFinish={async (values) => {
              handleFieldUpdate(index, values);
              return true;
            }}
          />
          <Popconfirm
            title="确定删除该字段?"
            onConfirm={() => handleFieldDelete(index)}
          >
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const columns: ProColumns<FormDefRecord>[] = [
    { title: '表单名称', dataIndex: 'name', copyable: true },
    { title: 'ID', dataIndex: 'id', copyable: true, search: false },
    { title: '描述', dataIndex: 'description', search: false },
    { title: '版本', dataIndex: 'version', search: false, width: 70 },
    { title: '更新时间', dataIndex: 'updatedAt', valueType: 'dateTime', search: false },
    {
      title: '操作',
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
                message.error('加载表单定义失败');
              }
            }}
          >
            预览
          </Button>
        </PermissionGuard>,
        <PermissionGuard key="edit" permission="form:update" fallback={null}>
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => openEditDrawer(record)}
          >
            编辑
          </Button>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="form:delete" fallback={null}>
          <Button
            type="link"
            danger
            onClick={async () => {
              await httpClient.delete(`/form/definition/${record.id}`);
              message.success('已删除');
              actionRef.current?.reload();
            }}
          >
            删除
          </Button>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title="表单引擎">
      <ProTable<FormDefRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        request={(params) => queryRequest<FormDefRecord>('/form/definition', params)}
        toolBarRender={() => [
          <PermissionGuard key="create" permission="form:add">
            <ModalForm
              title="新建表单定义"
              trigger={<Button type="primary" icon={<PlusOutlined />}>新建表单</Button>}
              onFinish={async (values) => {
                await httpClient.post('/form/definition', values);
                message.success('创建成功');
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormText name="name" label="表单名称" rules={[{ required: true }]} />
              <ProFormTextArea name="description" label="描述" />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />

      {/* Preview Modal */}
      <Modal
        open={!!previewDef}
        title={`预览：${previewDef?.name ?? ''}`}
        footer={null}
        onCancel={() => setPreviewDef(null)}
        width={700}
        destroyOnClose
      >
        {previewDef && (
          <DynamicForm
            definition={previewDef}
            onFinish={async () => {
              message.info('预览模式，不实际提交');
            }}
            submitText="预览提交"
          />
        )}
      </Modal>

      {/* Edit Drawer */}
      <Drawer
        title="编辑表单定义"
        width={720}
        open={editDrawerOpen}
        onClose={() => setEditDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setEditDrawerOpen(false)}>取消</Button>
            <Button type="primary" onClick={handleSaveEdit}>
              保存
            </Button>
          </Space>
        }
      >
        {editDef && (
          <>
            <Form form={editForm} layout="vertical" style={{ marginBottom: 24 }}>
              <Form.Item
                name="name"
                label="表单名称"
                rules={[{ required: true, message: '请输入表单名称' }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="description" label="描述">
                <Input.TextArea rows={2} />
              </Form.Item>
            </Form>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h4 style={{ margin: 0 }}>字段列表</h4>
              <FieldEditor
                trigger={
                  <Button type="primary" size="small" icon={<PlusOutlined />}>
                    添加字段
                  </Button>
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
              columns={fieldColumns as any}
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
