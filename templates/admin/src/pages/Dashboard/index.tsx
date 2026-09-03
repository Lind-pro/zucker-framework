import React, { useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  Card,
  Col,
  Row,
  Statistic,
  Timeline,
  Empty,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  UserOutlined,
  TeamOutlined,
  LockOutlined,
  MoneyCollectOutlined,
  SettingOutlined,
  FileTextOutlined,
  MenuOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router';
import httpClient from '@/lib/http-client';
import useThemeStore from '@/stores/useThemeStore';

const { Text } = Typography;

/* ---------- types ---------- */

interface HealthResult {
  status: 'UP' | 'DOWN' | 'DEGRADED';
  details?: Record<string, unknown>;
}

interface AccessLogItem {
  id?: string;
  method?: string;
  url?: string;
  createTime?: number | string;
  ip?: string;
  action?: string;
  describe?: string;
}

/* ---------- constants ---------- */

const iconWrapStyle = (bg: string): React.CSSProperties => ({
  width: 56,
  height: 56,
  borderRadius: '50%',
  background: bg,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
});

const methodColorMap: Record<string, string> = {
  GET: '#1677ff',
  POST: '#52c41a',
  PUT: '#fa8c16',
  DELETE: '#ff4d4f',
};

const quickLinks: {
  label: string;
  icon: React.ReactNode;
  route: string;
}[] = [
  { label: '用户管理', icon: <UserOutlined style={{ fontSize: 28, color: '#4338CA' }} />, route: '/users' },
  { label: '角色管理', icon: <TeamOutlined style={{ fontSize: 28, color: '#059669' }} />, route: '/roles' },
  { label: '权限管理', icon: <LockOutlined style={{ fontSize: 28, color: '#D97706' }} />, route: '/permissions' },
  { label: '菜单管理', icon: <MenuOutlined style={{ fontSize: 28, color: '#0891B2' }} />, route: '/menu' },
  { label: '系统配置', icon: <SettingOutlined style={{ fontSize: 28, color: '#7C3AED' }} />, route: '/config' },
  { label: '操作日志', icon: <FileTextOutlined style={{ fontSize: 28, color: '#BE185D' }} />, route: '/access-log' },
];

/* ---------- helpers ---------- */

function formatTime(ts: number | string | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- component ---------- */

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const isDark = useThemeStore((s) => s.themeMode === 'dark');

  const [userCount, setUserCount] = useState<number>(0);
  const [roleCount, setRoleCount] = useState<number>(0);
  const [permCount, setPermCount] = useState<number>(0);
  const [creditCount, setCreditCount] = useState<number>(0);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [logs, setLogs] = useState<AccessLogItem[]>([]);

  useEffect(() => {
    Promise.allSettled([
      httpClient.post<{ total: number }>('/users/_count', {}),
      httpClient.post<{ total: number }>('/roles/_count', {}),
      httpClient.post<{ total: number }>('/permissions/_count', {}),
      httpClient.post<{ total: number }>('/credit/_count', {}),
      httpClient.get<HealthResult>('/health'),
      httpClient.post<{ data: AccessLogItem[] }>('/logging/access/_query', {
        pageIndex: 0,
        pageSize: 10,
      }),
    ]).then(([users, roles, perms, credits, healthRes, logsRes]) => {
      if (users.status === 'fulfilled') setUserCount(users.value?.total ?? 0);
      if (roles.status === 'fulfilled') setRoleCount(roles.value?.total ?? 0);
      if (perms.status === 'fulfilled') setPermCount(perms.value?.total ?? 0);
      if (credits.status === 'fulfilled') setCreditCount(credits.value?.total ?? 0);
      if (healthRes.status === 'fulfilled') {
        const h = healthRes.value;
        if (h && typeof h.status === 'string') {
          h.status = h.status.toUpperCase() as HealthResult['status'];
        }
        setHealth(h);
      }
      if (logsRes.status === 'fulfilled') {
        const raw = logsRes.value;
        setLogs(Array.isArray(raw) ? raw : Array.isArray((raw as any)?.data) ? (raw as any).data : []);
      }
    });
  }, []);

  /* ---------- stat cards config ---------- */

  const stats: {
    title: string;
    value: number | string;
    icon: React.ReactNode;
    bg: string;
    color?: string;
  }[] = [
    {
      title: '系统状态',
      value: health?.status ?? '--',
      icon: <CheckCircleOutlined style={{ fontSize: 28, color: '#fff' }} />,
      bg: '#1677ff',
      color:
        health?.status === 'UP'
          ? '#059669'
          : health?.status === 'DEGRADED'
            ? '#D97706'
            : health?.status === 'DOWN'
              ? '#DC2626'
              : undefined,
    },
    {
      title: '用户总数',
      value: userCount,
      icon: <UserOutlined style={{ fontSize: 28, color: '#fff' }} />,
      bg: '#4338CA',
    },
    {
      title: '角色数量',
      value: roleCount,
      icon: <TeamOutlined style={{ fontSize: 28, color: '#fff' }} />,
      bg: '#059669',
    },
    {
      title: '权限数量',
      value: permCount,
      icon: <LockOutlined style={{ fontSize: 28, color: '#fff' }} />,
      bg: '#D97706',
    },
    {
      title: '积分记录',
      value: creditCount,
      icon: <MoneyCollectOutlined style={{ fontSize: 28, color: '#fff' }} />,
      bg: '#DC2626',
    },
  ];

  return (
    <PageContainer title="仪表盘">
      {/* ---- Row 1: Stat Cards ---- */}
      <Row gutter={[16, 16]}>
        {stats.map((s) => (
          <Col xs={24} sm={12} lg={Math.floor(24 / stats.length)} key={s.title}>
            <Card hoverable styles={{ body: { display: 'flex', alignItems: 'center', gap: 16 } }}>
              <div style={iconWrapStyle(s.bg)}>{s.icon}</div>
              <Statistic
                title={s.title}
                value={s.value}
                valueStyle={s.color ? { color: s.color } : undefined}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* ---- Row 2: Timeline + Quick Links ---- */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* Left: Recent operations */}
        <Col xs={24} lg={14}>
          <Card title="最近操作" styles={{ body: { maxHeight: 420, overflow: 'auto' } }}>
            {logs.length === 0 ? (
              <Empty description="暂无操作记录" />
            ) : (
              <Timeline
                items={logs.map((log) => ({
                  color: methodColorMap[log.method?.toUpperCase() ?? ''] ?? '#999',
                  children: (
                    <div>
                      <Text strong style={{ color: methodColorMap[log.method?.toUpperCase() ?? ''] ?? '#333' }}>
                        {log.method?.toUpperCase()}
                      </Text>{' '}
                      <Text>{log.url}</Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {formatTime(log.createTime)}
                      </Text>
                    </div>
                  ),
                }))}
              />
            )}
          </Card>
        </Col>

        {/* Right: Quick actions */}
        <Col xs={24} lg={10}>
          <Card title="快捷操作">
            <Row gutter={[16, 24]}>
              {quickLinks.map((link) => (
                <Col span={8} key={link.route}>
                  <div
                    onClick={() => navigate(link.route)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      cursor: 'pointer',
                      padding: '12px 0',
                      borderRadius: 8,
                      transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = isDark ? 'rgba(255,255,255,0.06)' : '#f5f5f5';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                    }}
                  >
                    <div
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: '50%',
                        background: isDark ? 'rgba(67,56,202,0.15)' : '#f0f5ff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginBottom: 8,
                      }}
                    >
                      {link.icon}
                    </div>
                    <Text style={{ fontSize: 13 }}>{link.label}</Text>
                  </div>
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};

export default Dashboard;
