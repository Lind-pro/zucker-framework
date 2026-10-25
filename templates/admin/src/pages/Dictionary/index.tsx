import { useAdminI18n } from '@/i18n';
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
  text: string;
  value: string;
  ordinal: number;
}

const DictionaryPage: React.FC = () => {
  const { t } = useAdminI18n();

  const isDark = useThemeStore((s) => s.themeMode === 'dark');
  const typeActionRef = useRef<ActionType>(null);
  const itemActionRef = useRef<ActionType>(null);
  const {
    rowSelection: itemRowSelection,
    batchDelete: batchDeleteItems,
    selectedRowKeys: selectedItemKeys,
    clearSelection: clearItemSelection,
  } = useBatchDelete('/dictionary-item', itemActionRef);
  const [selectedType, setSelectedType] = useState<DictType | null>(null);

  function selectType(record: DictType) {
    clearItemSelection();
    setSelectedType(record);
  }
  const typeColumns: ProColumns<DictType>[] = [
    { title: t('字典名称'), dataIndex: 'name' },
    { title: t('分类编码'), dataIndex: 'classified', copyable: true },
    {
      title: t('操作'),
      valueType: 'option',
      width: 180,
      render: (_, record) => [
        <a
          key="view"
          onClick={(event) => {
            event.stopPropagation();
            selectType(record);
          }}
        >
          {t('查看项')}
        </a>,
        <PermissionGuard key="edit" permission="dictionary:update">
          <ModalForm<Omit<DictType, 'id'>>
            name={`dictionary-edit-${record.id}`}
            title={t('编辑字典类型')}
            trigger={<a>{t('编辑')}</a>}
            initialValues={{
              name: record.name,
              classified: record.classified,
              describe: record.describe,
            }}
            modalProps={{ destroyOnHidden: true }}
            onFinish={async (values) => {
              try {
                await httpClient.put(`/dictionary/${encodeURIComponent(record.id)}`, values);
                if (selectedType?.id === record.id) setSelectedType({ ...record, ...values });
                message.success(t('编辑成功'));
                typeActionRef.current?.reload();
                return true;
              } catch {
                message.error(
                  t(
                    '字典保存未确认，请核对字段、权限和连接后重试；当前草稿已保留。',
                    'Dictionary save was not confirmed. Check the fields, access and connection, then retry. Your draft is kept.',
                  ),
                );
                return false;
              }
            }}
          >
            <ProFormText name="name" label={t('字典名称')} rules={[{ required: true }]} />
            <ProFormText name="classified" label={t('分类编码')} rules={[{ required: true }]} />
            <ProFormText name="describe" label={t('描述')} />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="dictionary:delete">
          <Popconfirm
            title={t('确定删除?')}
            onConfirm={async () => {
              await httpClient.delete(`/dictionary/${encodeURIComponent(record.id)}`);
              if (selectedType?.id === record.id) {
                clearItemSelection();
                setSelectedType(null);
              }
              message.success(t('删除成功'));
              typeActionRef.current?.reload();
            }}
          >
            <a style={{ color: '#DC2626' }}>{t('删除')}</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  const itemColumns: ProColumns<DictItem>[] = [
    { title: t('标签'), dataIndex: 'text' },
    { title: t('值'), dataIndex: 'value', render: (_, r) => String(r.value ?? '') },
    { title: t('排序'), dataIndex: 'ordinal', search: false },
    {
      title: t('操作'),
      valueType: 'option',
      width: 140,
      render: (_, record) => [
        <PermissionGuard key="edit" permission="dictionary:update">
          <ModalForm<{ text: string; value: string; ordinal: number }>
            name={`dictionary-item-edit-${record.id}`}
            title={t('编辑字典项')}
            trigger={<a>{t('编辑')}</a>}
            initialValues={{
              text: record.text,
              value: record.value != null ? String(record.value) : '',
              ordinal: record.ordinal,
            }}
            modalProps={{ destroyOnHidden: true }}
            onFinish={async (values) => {
              try {
                await httpClient.put(`/dictionary-item/${record.id}`, values);
                message.success(t('编辑成功'));
                itemActionRef.current?.reload();
                return true;
              } catch {
                message.error(
                  t(
                    '字典保存未确认，请核对字段、权限和连接后重试；当前草稿已保留。',
                    'Dictionary save was not confirmed. Check the fields, access and connection, then retry. Your draft is kept.',
                  ),
                );
                return false;
              }
            }}
          >
            <ProFormText name="text" label={t('标签')} rules={[{ required: true }]} />
            <ProFormText name="value" label={t('值')} rules={[{ required: true }]} />
            <ProFormDigit name="ordinal" label={t('排序')} />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="dictionary:delete">
          <Popconfirm
            title={t('确定删除?')}
            onConfirm={async () => {
              await httpClient.delete(`/dictionary-item/${record.id}`);
              message.success(t('删除成功'));
              itemActionRef.current?.reload();
            }}
          >
            <a style={{ color: '#DC2626' }}>{t('删除')}</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title={t('字典管理')}>
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={10}>
          <Card title={t('字典类型')} aria-label={t('字典类型')}>
            <ProTable<DictType>
              scroll={{ x: 'max-content' }}
              actionRef={typeActionRef}
              rowKey="id"
              columns={typeColumns}
              search={false}
              request={(params) => queryRequest<DictType>('/dictionary', params)}
              toolBarRender={() => [
                <PermissionGuard key="create" permission="dictionary:add">
                  <ModalForm
                    name="dictionary-create"
                    title={t('新建字典类型')}
                    trigger={
                      <Button type="primary" icon={<PlusOutlined />}>
                        {t('新建')}
                      </Button>
                    }
                    onFinish={async (values) => {
                      try {
                        await httpClient.post('/dictionary', values);
                        message.success(t('创建成功'));
                        typeActionRef.current?.reload();
                        return true;
                      } catch {
                        message.error(
                          t(
                            '字典保存未确认，请核对字段、权限和连接后重试；当前草稿已保留。',
                            'Dictionary save was not confirmed. Check the fields, access and connection, then retry. Your draft is kept.',
                          ),
                        );
                        return false;
                      }
                    }}
                  >
                    <ProFormText name="name" label={t('字典名称')} rules={[{ required: true }]} />
                    <ProFormText
                      name="classified"
                      label={t('分类编码')}
                      rules={[{ required: true }]}
                    />
                    <ProFormText name="describe" label={t('描述')} />
                  </ModalForm>
                </PermissionGuard>,
              ]}
              onRow={(record) => ({
                onClick: () => {
                  selectType(record);
                },
                style: {
                  cursor: 'pointer',
                  background:
                    selectedType?.id === record.id
                      ? isDark
                        ? 'rgba(67,56,202,0.15)'
                        : '#EEF2FF'
                      : undefined,
                },
              })}
            />
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            title={selectedType ? `${selectedType.name} — ${t('字典项')}` : t('字典项')}
            aria-label={t('字典项')}
          >
            {selectedType ? (
              <ProTable<DictItem>
                key={selectedType.id}
                scroll={{ x: 'max-content' }}
                actionRef={itemActionRef}
                rowKey="id"
                columns={itemColumns}
                rowSelection={itemRowSelection}
                search={false}
                request={(params) =>
                  queryRequest<DictItem>('/dictionary-item', {
                    ...params,
                    dictId: selectedType.id,
                  })
                }
                toolBarRender={() => [
                  selectedItemKeys.length > 0 && (
                    <PermissionGuard key="batch-delete" permission="dictionary:delete">
                      <Popconfirm
                        title={t('确定删除选中的 {count} 条记录？', undefined, {
                          count: selectedItemKeys.length,
                        })}
                        onConfirm={batchDeleteItems}
                      >
                        <Button danger icon={<DeleteOutlined />}>
                          {t('批量删除 (')}
                          {selectedItemKeys.length})
                        </Button>
                      </Popconfirm>
                    </PermissionGuard>
                  ),
                  <PermissionGuard key="create" permission="dictionary:add">
                    <ModalForm
                      name={`dictionary-item-create-${selectedType.id}`}
                      title={t('新建字典项')}
                      trigger={
                        <Button type="primary" icon={<PlusOutlined />}>
                          {t('新建')}
                        </Button>
                      }
                      onFinish={async (values) => {
                        try {
                          await httpClient.post('/dictionary-item', {
                            ...values,
                            dictId: selectedType.id,
                          });
                          message.success(t('创建成功'));
                          itemActionRef.current?.reload();
                          return true;
                        } catch {
                          message.error(
                            t(
                              '字典保存未确认，请核对字段、权限和连接后重试；当前草稿已保留。',
                              'Dictionary save was not confirmed. Check the fields, access and connection, then retry. Your draft is kept.',
                            ),
                          );
                          return false;
                        }
                      }}
                    >
                      <ProFormText name="text" label={t('标签')} rules={[{ required: true }]} />
                      <ProFormText name="value" label={t('值')} rules={[{ required: true }]} />
                      <ProFormDigit name="ordinal" label={t('排序')} initialValue={0} />
                    </ModalForm>
                  </PermissionGuard>,
                ]}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: 48, color: '#999' }}>
                {t('请点击左侧字典类型查看字典项')}
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};

export default DictionaryPage;
