import React, { useRef, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Tag, Drawer, Descriptions, Typography } from 'antd';
import { queryRequest } from '@/lib/http-client';

interface AccessLogRecord {
  id: string;
  method: string;
  url: string;
  statusCode: number;
  duration: number;
  userId?: string;
  username?: string;
  ip: string;
  userAgent?: string;
  requestBody?: string;
  responseBody?: string;
  createdAt: string;
}

const methodColorMap: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
  PUT: 'orange',
  DELETE: 'red',
  PATCH: 'purple',
};

const statusColor = (code: number) => {
  if (code < 300) return 'success';
  if (code < 400) return 'warning';
  return 'error';
};

const AccessLogPage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);
  const [detailRecord, setDetailRecord] = useState<AccessLogRecord | null>(null);

  const columns: ProColumns<AccessLogRecord>[] = [
    {
      title: '方法',
      dataIndex: 'method',
      width: 80,
      render: (_, record) => (
        <Tag color={methodColorMap[record.method] ?? 'default'}>{record.method}</Tag>
      ),
    },
    { title: '请求路径', dataIndex: 'url', ellipsis: true, copyable: true },
    {
      title: '状态码',
      dataIndex: 'statusCode',
      width: 90,
      render: (_, record) => (
        <Tag color={statusColor(record.statusCode)}>{record.statusCode}</Tag>
      ),
    },
    {
      title: '耗时(ms)',
      dataIndex: 'duration',
      width: 100,
      search: false,
      render: (_, record) => (
        <span style={{ color: record.duration > 1000 ? '#DC2626' : record.duration > 500 ? '#D97706' : '#059669' }}>
          {record.duration}
        </span>
      ),
    },
    { title: '用户', dataIndex: 'username', width: 120 },
    { title: 'IP', dataIndex: 'ip', width: 130, copyable: true },
    {
      title: '时间',
      dataIndex: 'createdAt',
      valueType: 'dateTimeRange',
      search: {
        transform: (value) => ({
          'createdAt$gte': value[0],
          'createdAt$lte': value[1],
        }),
      },
      render: (_, record) => record.createdAt,
      width: 170,
    },
    {
      title: '操作',
      valueType: 'option',
      width: 80,
      render: (_, record) => [
        <a key="detail" onClick={() => setDetailRecord(record)}>详情</a>,
      ],
    },
  ];

  return (
    <PageContainer title="访问日志">
      <ProTable<AccessLogRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        request={(params) => queryRequest<AccessLogRecord>('/logging/access', params)}
        toolBarRender={false}
      />

      <Drawer
        title="日志详情"
        open={!!detailRecord}
        onClose={() => setDetailRecord(null)}
        width={560}
      >
        {detailRecord && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="请求方法">
              <Tag color={methodColorMap[detailRecord.method] ?? 'default'}>
                {detailRecord.method}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="请求路径">
              <Typography.Text copyable>{detailRecord.url}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="状态码">
              <Tag color={statusColor(detailRecord.statusCode)}>
                {detailRecord.statusCode}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="响应耗时">
              <span style={{
                color: detailRecord.duration > 1000 ? '#DC2626'
                  : detailRecord.duration > 500 ? '#D97706' : '#059669',
                fontWeight: 600,
              }}>
                {detailRecord.duration} ms
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="用户ID">{detailRecord.userId ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="用户名">{detailRecord.username ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="客户端IP">
              <Typography.Text copyable>{detailRecord.ip}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="User-Agent">
              <Typography.Paragraph
                ellipsis={{ rows: 2, expandable: true }}
                style={{ marginBottom: 0 }}
              >
                {detailRecord.userAgent ?? '-'}
              </Typography.Paragraph>
            </Descriptions.Item>
            <Descriptions.Item label="请求时间">
              {new Date(detailRecord.createdAt).toLocaleString('zh-CN')}
            </Descriptions.Item>
            {detailRecord.requestBody && (
              <Descriptions.Item label="请求体">
                <Typography.Paragraph
                  code
                  ellipsis={{ rows: 5, expandable: true }}
                  style={{ marginBottom: 0, maxWidth: 400 }}
                >
                  {detailRecord.requestBody}
                </Typography.Paragraph>
              </Descriptions.Item>
            )}
            {detailRecord.responseBody && (
              <Descriptions.Item label="响应体">
                <Typography.Paragraph
                  code
                  ellipsis={{ rows: 5, expandable: true }}
                  style={{ marginBottom: 0, maxWidth: 400 }}
                >
                  {detailRecord.responseBody}
                </Typography.Paragraph>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Drawer>
    </PageContainer>
  );
};

export default AccessLogPage;
