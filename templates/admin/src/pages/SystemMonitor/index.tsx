import { useAdminI18n } from '@/i18n';
import { useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Space, Statistic, Switch, Tag, Typography } from 'antd';
import httpClient from '@/lib/http-client';
interface Health {
  status: 'up' | 'down' | 'degraded';
  checks: Record<string, { status: string; details?: Record<string, unknown> }>;
  timestamp: string;
  uptime?: number;
}
const labels: Record<string, string> = { up: '正常', down: '异常', degraded: '降级' };
export default function SystemMonitor() {
  const { t, localeTag } = useAdminI18n();
  const [health, setHealth] = useState<Health | null>(null),
    [failed, setFailed] = useState(false),
    [refresh, setRefresh] = useState(0),
    [auto, setAuto] = useState(false);
  useEffect(() => {
    let active = true;
    void httpClient
      .get<Health>('/health')
      .then((result) => {
        if (!['up', 'down', 'degraded'].includes(result.status) || !result.checks)
          throw new Error('Unexpected health response');
        if (active) {
          setHealth(result);
          setFailed(false);
        }
      })
      .catch((error) => {
        const response =
          error && typeof error === 'object' && 'response' in error
            ? (error.response as { data?: unknown })?.data
            : undefined;
        if (!active) return;
        if (
          response &&
          typeof response === 'object' &&
          'status' in response &&
          response.status === 'down' &&
          'checks' in response
        ) {
          setHealth(response as Health);
          setFailed(false);
        } else setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => setRefresh((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, [auto]);
  const checks = Object.entries(health?.checks ?? {});
  return (
    <PageContainer
      title={t('健康检查')}
      extra={
        <Space>
          <Switch
            checked={auto}
            onChange={setAuto}
            checkedChildren={t('自动刷新')}
            unCheckedChildren={t('手动刷新')}
          />
          <Button onClick={() => setRefresh((value) => value + 1)}>{t('刷新')}</Button>
        </Space>
      }
    >
      <p style={{ marginTop: 0, marginBottom: 20, opacity: 0.75 }}>
        {t('展示服务进程及已注册的依赖检查。读取失败与依赖异常分别显示。')}
      </p>
      {failed && (
        <Alert
          type="error"
          showIcon
          message={t('健康信息读取失败')}
          description={t(
            '连接或接口不可用；无法据此判断所有服务已停止。下面保留上一次成功读取的结果。',
          )}
          style={{ marginBottom: 20 }}
        />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card loading={!health && !failed}>
            <Statistic
              title={t('最近一次健康结果')}
              value={health ? t(labels[health.status] ?? '未知') : t('未知')}
            />
            <Typography.Text type="secondary">
              {health
                ? new Date(health.timestamp).toLocaleString(localeTag)
                : t('尚无成功检查记录')}
            </Typography.Text>
          </Card>
        </Col>
        {checks.map(([name, check]) => (
          <Col xs={24} md={8} key={name}>
            <Card title={name}>
              <Tag
                color={
                  check.status === 'up' ? 'success' : check.status === 'down' ? 'error' : 'warning'
                }
              >
                {t(labels[check.status] ?? '未知')}
              </Tag>
            </Card>
          </Col>
        ))}
      </Row>
      {health && !checks.length && (
        <Alert
          type="info"
          showIcon
          message={t('尚未注册依赖探针')}
          description={t('当前响应只说明健康入口可访问，不能证明数据库、Redis 或外部提供者可用。')}
          style={{ marginTop: 20 }}
        />
      )}
    </PageContainer>
  );
}
