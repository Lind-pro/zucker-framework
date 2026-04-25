import React, { useRef } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Tag } from 'antd';
import { queryRequest } from '@/lib/http-client';

interface NotifyHistory {
  id: string;
  templateId: string;
  templateName: string;
  type: string;
  target: string;
  success: boolean;
  errorMessage?: string;
  createdAt: string;
}

const NotifyHistoryPage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);

  const columns: ProColumns<NotifyHistory>[] = [
    { title: '模板', dataIndex: 'templateName' },
    { title: '类型', dataIndex: 'type' },
    { title: '接收方', dataIndex: 'target', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'success',
      render: (_, record) => (
        <Tag color={record.success ? 'success' : 'error'}>
          {record.success ? '成功' : '失败'}
        </Tag>
      ),
    },
    { title: '失败原因', dataIndex: 'errorMessage', search: false, ellipsis: true },
    { title: '发送时间', dataIndex: 'createdAt', valueType: 'dateTime', search: false },
  ];

  return (
    <PageContainer title="发送历史">
      <ProTable<NotifyHistory>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        request={(params) => queryRequest<NotifyHistory>('/notification/history', params)}
        toolBarRender={false}
      />
    </PageContainer>
  );
};

export default NotifyHistoryPage;
