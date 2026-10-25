import { useAdminI18n } from '@/i18n';
import { useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Empty, Row, Space, Statistic } from 'antd';
import { Link } from 'react-router';
import httpClient from '@/lib/http-client';
import useAuthStore from '@/stores/useAuthStore';
import { adminRoutes } from '@/config/admin-navigation';
type Metric = {
  key: string;
  label: string;
  path: string;
  permission: string;
  value?: number;
  failed?: boolean;
};
const definitions: Metric[] = [
  { key: 'users', label: '用户总数', path: '/users', permission: 'users:query' },
  { key: 'roles', label: '角色数量', path: '/roles', permission: 'roles:query' },
  { key: 'permissions', label: '权限数量', path: '/permissions', permission: 'permissions:query' },
  { key: 'credit', label: '积分记录', path: '/credit', permission: 'credit:query' },
];
export default function Dashboard() {
  const { t } = useAdminI18n();
  const hasPermission = useAuthStore((state) => state.hasPermission),
    permissions = useAuthStore((state) => state.permissions);
  const [metrics, setMetrics] = useState<Metric[] | null>(null),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const available = definitions.filter((item) => hasPermission(item.permission));
    void Promise.all(
      available.map(async (item) => {
        try {
          const result =
            item.key === 'credit'
              ? await httpClient.get<{ total: number }>('/management/credits', {
                  page: 1,
                  pageSize: 1,
                })
              : await httpClient.post<{ total: number }>(`${item.path}/_count`, {});
          if (!Number.isSafeInteger(result.total) || result.total < 0)
            throw new Error('Invalid count');
          return { ...item, value: result.total };
        } catch {
          return { ...item, failed: true };
        }
      }),
    ).then((result) => {
      if (active) setMetrics(result);
    });
    return () => {
      active = false;
    };
  }, [hasPermission, permissions, retry]);
  return (
    <PageContainer
      title={t('概览')}
      extra={
        <Button
          onClick={() => {
            setMetrics(null);
            setRetry((value) => value + 1);
          }}
        >
          {t('刷新')}
        </Button>
      }
    >
      <p style={{ marginTop: 0, marginBottom: 20, opacity: 0.75 }}>
        {t('查看已授权资源摘要；服务健康、任务详情与审计记录各有独立入口。')}
      </p>
      <Row gutter={[16, 16]}>
        {metrics === null ? (
          <Col span={24}>
            <Card loading />
          </Col>
        ) : metrics.length ? (
          metrics.map((item) => (
            <Col xs={24} sm={12} lg={6} key={item.key}>
              <Card>
                <Statistic title={t(item.label)} value={item.failed ? t('暂不可用') : item.value} />
                {item.failed ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={t('未能读取，不代表记录为零')}
                    style={{ marginTop: 12 }}
                  />
                ) : (
                  <Link to={item.path}>{t('查看记录')}</Link>
                )}
              </Card>
            </Col>
          ))
        ) : (
          <Col span={24}>
            <Card>
              <Empty description={t('当前没有可读取的统计资源')} />
            </Card>
          </Col>
        )}
      </Row>
      <Card title={t('常用入口')} style={{ marginTop: 20 }}>
        <Space wrap>
          {Object.entries(adminRoutes)
            .filter(
              ([path, route]) =>
                !['/dashboard', '/profile'].includes(path) &&
                (!route.permission || hasPermission(route.permission)),
            )
            .map(([path, route]) => (
              <Link key={path} to={path}>
                <Button>{t(route.name)}</Button>
              </Link>
            ))}
        </Space>
      </Card>
    </PageContainer>
  );
}
