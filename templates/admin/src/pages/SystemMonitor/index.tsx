import React, { useEffect, useState, useCallback } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { Card, Row, Col, Badge, Statistic, Switch, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import httpClient from '@/lib/http-client';
import { queryRequest } from '@/lib/http-client';

interface HealthResult {
  status: string;
  details?: Record<string, { status: string; message?: string }>;
}

interface ErrorLogRecord {
  id: string;
  method: string;
  url: string;
  statusCode: number;
  duration: number;
  username?: string;
  createdAt: string;
}

const statusIcon = (status: string) => {
  const upper = status?.toUpperCase();
  if (upper === 'UP') return <CheckCircleOutlined style={{ color: '#059669', fontSize: 24 }} />;
  if (upper === 'DEGRADED') return <WarningOutlined style={{ color: '#D97706', fontSize: 24 }} />;
  return <CloseCircleOutlined style={{ color: '#DC2626', fontSize: 24 }} />;
};

const statusBadge = (status: string): 'success' | 'warning' | 'error' => {
  const upper = status?.toUpperCase();
  if (upper === 'UP') return 'success';
  if (upper === 'DEGRADED') return 'warning';
  return 'error';
};

const componentIcons: Record<string, React.ReactNode> = {
  database: <DatabaseOutlined />,
  redis: <CloudServerOutlined />,
  api: <ApiOutlined />,
};

const methodColorMap: Record<string, string> = {
  GET: 'blue', POST: 'green', PUT: 'orange', DELETE: 'red', PATCH: 'purple',
};

const SystemMonitorPage: React.FC = () => {
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);

  const fetchHealth = useCallback(() => {
    httpClient.get<HealthResult>('/health').then(setHealth).catch(() =>
      setHealth({ status: 'DOWN' }),
    );
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth, refreshCount]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => setRefreshCount((c) => c + 1), 30000);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  const details = health?.details ?? {};
  const detailEntries = Object.entries(details);

  const errorColumns: ProColumns<ErrorLogRecord>[] = [
    {
      title: '方法', dataIndex: 'method', width: 80,
      render: (_, r) => <Tag color={methodColorMap[r.method] ?? 'default'}>{r.method}</Tag>,
    },
    { title: '路径', dataIndex: 'url', ellipsis: true },
    {
      title: '状态码', dataIndex: 'statusCode', width: 90,
      render: (_, r) => <Tag color="error">{r.statusCode}</Tag>,
    },
    {
      title: '耗时', dataIndex: 'duration', width: 90, search: false,
      render: (_, r) => <span style={{ color: '#DC2626' }}>{r.duration}ms</span>,
    },
    { title: '用户', dataIndex: 'username', width: 100 },
    { title: '时间', dataIndex: 'createdAt', valueType: 'dateTime', width: 170, search: false },
  ];

  return (
    <PageContainer
      title="系统监控"
      extra={
        <Space>
          <span>自动刷新</span>
          <Switch checked={autoRefresh} onChange={setAutoRefresh} />
          <a onClick={fetchHealth}><ReloadOutlined /> 刷新</a>
        </Space>
      }
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="系统状态"
              value={health?.status?.toUpperCase() ?? '检查中'}
              prefix={health ? statusIcon(health.status) : <ReloadOutlined spin />}
              valueStyle={{
                color: health?.status?.toUpperCase() === 'UP' ? '#059669'
                  : health?.status?.toUpperCase() === 'DEGRADED' ? '#D97706' : '#DC2626',
              }}
            />
          </Card>
        </Col>

        {detailEntries.map(([name, detail]) => (
          <Col xs={24} sm={12} lg={6} key={name}>
            <Card>
              <Space>
                <Badge status={statusBadge(detail.status)} />
                <span style={{ fontSize: 16 }}>
                  {componentIcons[name] ?? <ApiOutlined />}
                </span>
              </Space>
              <Statistic
                title={name.charAt(0).toUpperCase() + name.slice(1)}
                value={detail.status?.toUpperCase()}
                valueStyle={{
                  fontSize: 16,
                  color: detail.status?.toUpperCase() === 'UP' ? '#059669' : '#DC2626',
                }}
              />
              {detail.message && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {detail.message}
                </Typography.Text>
              )}
            </Card>
          </Col>
        ))}

        {detailEntries.length === 0 && health && (
          <Col xs={24} sm={12} lg={6}>
            <Card>
              <Statistic title="组件详情" value="无额外组件" />
            </Card>
          </Col>
        )}
      </Row>

      <Card title="最近错误请求 (4xx/5xx)" style={{ marginTop: 16 }}>
        <ProTable<ErrorLogRecord>
          rowKey="id"
          columns={errorColumns}
          request={async (params) => {
            const result = await queryRequest<ErrorLogRecord>('/logging/access', {
              ...params,
              'statusCode$gte': 400,
              pageSize: 10,
            });
            return result;
          }}
          search={false}
          pagination={{ pageSize: 10 }}
          toolBarRender={false}
          size="small"
        />
      </Card>
    </PageContainer>
  );
};

export default SystemMonitorPage;
