import React, { useRef, useState } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormDigit,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, message, Popconfirm, Card, Col, Row } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import httpClient, { queryRequest } from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';
import useThemeStore from '@/stores/useThemeStore';

interface DictType {
  id: string;
  name: string;
  classified: string;
  describe: string;
}

interface DictItem {
  id: string;
  dictId: string;
  label: string;
  value: unknown;
  sortIndex: number;
}

const DictionaryPage: React.FC = () => {
  const isDark = useThemeStore((s) => s.themeMode === 'dark');
  const typeActionRef = useRef<ActionType>(null);
  const itemActionRef = useRef<ActionType>(null);
  const { rowSelection: itemRowSelection, batchDelete: batchDeleteItems, selectedRowKeys: selectedItemKeys } = useBatchDelete('/dictionary-item', itemActionRef);
  const [selectedType, setSelectedType] = useState<DictType | null>(null);

  const typeColumns: ProColumns<DictType>[] = [
    { title: '字典名称', dataIndex: 'name' },
    { title: '分类编码', dataIndex: 'classified', copyable: true },
    {
      title: '操作',
      valueType: 'option',
      width: 180,
      render: (_, record) => [
        <a key="view" onClick={() => { setSelectedType(record); itemActionRef.current?.reload(); }}>
          查看项
        </a>,
        <PermissionGuard key="edit" permission="dictionary:update">
          <ModalForm<Omit<DictType, 'id'>>
            title="编辑字典类型"
            trigger={<a>编辑</a>}
            initialValues={{
              name: record.name,
              classified: record.classified,
              describe: record.describe,
            }}
            modalProps={{ destroyOnClose: true }}
            onFinish={async (values) => {
              await httpClient.put(`/dictionary/${record.id}`, values);
              message.success('编辑成功');
              typeActionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="name" label="字典名称" rules={[{ required: true }]} />
            <ProFormText name="classified" label="分类编码" rules={[{ required: true }]} />
            <ProFormText name="describe" label="描述" />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="dictionary:delete">
          <Popconfirm title="确定删除?" onConfirm={async () => {
            await httpClient.delete(`/dictionary/${record.id}`);
            message.success('删除成功');
            typeActionRef.current?.reload();
          }}>
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  const itemColumns: ProColumns<DictItem>[] = [
    { title: '标签', dataIndex: 'label' },
    { title: '值', dataIndex: 'value', render: (_, r) => String(r.value ?? '') },
    { title: '排序', dataIndex: 'sortIndex', search: false },
    {
      title: '操作',
      valueType: 'option',
      width: 140,
      render: (_, record) => [
        <PermissionGuard key="edit" permission="dictionary:update">
          <ModalForm<{ label: string; value: string; sortIndex: number }>
            title="编辑字典项"
            trigger={<a>编辑</a>}
            initialValues={{
              label: record.label,
              value: record.value != null ? String(record.value) : '',
              sortIndex: record.sortIndex,
            }}
            modalProps={{ destroyOnClose: true }}
            onFinish={async (values) => {
              await httpClient.put(`/dictionary-item/${record.id}`, values);
              message.success('编辑成功');
              itemActionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="label" label="标签" rules={[{ required: true }]} />
            <ProFormText name="value" label="值" rules={[{ required: true }]} />
            <ProFormDigit name="sortIndex" label="排序" />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="dictionary:delete">
          <Popconfirm title="确定删除?" onConfirm={async () => {
            await httpClient.delete(`/dictionary-item/${record.id}`);
            message.success('删除成功');
            itemActionRef.current?.reload();
          }}>
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title="字典管理">
      <Row gutter={24}>
        <Col span={10}>
          <Card title="字典类型">
            <ProTable<DictType>
              actionRef={typeActionRef}
              rowKey="id"
              columns={typeColumns}
              search={false}
              request={(params) => queryRequest<DictType>('/dictionary', params)}
              toolBarRender={() => [
                <PermissionGuard key="create" permission="dictionary:add">
                  <ModalForm
                    title="新建字典类型"
                    trigger={<Button type="primary" icon={<PlusOutlined />}>新建</Button>}
                    onFinish={async (values) => {
                      await httpClient.post('/dictionary', values);
                      message.success('创建成功');
                      typeActionRef.current?.reload();
                      return true;
                    }}
                  >
                    <ProFormText name="name" label="字典名称" rules={[{ required: true }]} />
                    <ProFormText name="classified" label="分类编码" rules={[{ required: true }]} />
                    <ProFormText name="describe" label="描述" />
                  </ModalForm>
                </PermissionGuard>,
              ]}
              onRow={(record) => ({
                onClick: () => { setSelectedType(record); itemActionRef.current?.reload(); },
                style: {
                  cursor: 'pointer',
                  background: selectedType?.id === record.id ? (isDark ? 'rgba(67,56,202,0.15)' : '#EEF2FF') : undefined,
                },
              })}
            />
          </Card>
        </Col>
        <Col span={14}>
          <Card title={selectedType ? `${selectedType.name} — 字典项` : '字典项'}>
            {selectedType ? (
              <ProTable<DictItem>
                actionRef={itemActionRef}
                rowKey="id"
                columns={itemColumns}
                rowSelection={itemRowSelection}
                search={false}
                request={(params) =>
                  queryRequest<DictItem>('/dictionary-item', {
                    ...params,
                    'dictId$eq': selectedType.id,
                  })
                }
                toolBarRender={() => [
                  selectedItemKeys.length > 0 && (
                    <PermissionGuard key="batch-delete" permission="dictionary:delete">
                      <Popconfirm title={`确定删除选中的 ${selectedItemKeys.length} 条记录?`} onConfirm={batchDeleteItems}>
                        <Button danger icon={<DeleteOutlined />}>
                          批量删除 ({selectedItemKeys.length})
                        </Button>
                      </Popconfirm>
                    </PermissionGuard>
                  ),
                  <PermissionGuard key="create" permission="dictionary:add">
                    <ModalForm
                      title="新建字典项"
                      trigger={<Button type="primary" icon={<PlusOutlined />}>新建</Button>}
                      onFinish={async (values) => {
                        await httpClient.post('/dictionary-item', {
                          ...values,
                          dictId: selectedType.id,
                        });
                        message.success('创建成功');
                        itemActionRef.current?.reload();
                        return true;
                      }}
                    >
                      <ProFormText name="label" label="标签" rules={[{ required: true }]} />
                      <ProFormText name="value" label="值" rules={[{ required: true }]} />
                      <ProFormDigit name="sortIndex" label="排序" initialValue={0} />
                    </ModalForm>
                  </PermissionGuard>,
                ]}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: 48, color: '#999' }}>
                请点击左侧字典类型查看字典项
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};

export default DictionaryPage;
