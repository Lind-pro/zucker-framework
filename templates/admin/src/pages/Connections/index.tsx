import { useAdminI18n } from '@/i18n';
import { useEffect, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { Alert, Button, Space, Tag, Typography } from 'antd';
import httpClient from '@/lib/http-client';
import { usePermission } from '@/lib/permission';
import ConnectionEditor from '@/features/connections/ConnectionEditor';
import type { ConnectionProfile, ConnectionSettings } from '@/features/connections/types';
interface Connection {
  id: string;
  name: string;
  category: string;
  source: string;
  status: string;
  enabled: boolean | null;
  missing: string[];
  sdkAvailable: boolean | null;
  mode?: string;
  note: string;
  configuredOfferCount?: number;
  registeredProviderIds?: string[];
  configurationSourceIds?: string[];
  storedRevision?: number;
  appliedRevision?: number;
  pendingRestart?: boolean;
}
const states: Record<string, string> = {
  configured: '本地配置已就绪',
  disabled: '未启用',
  missing: '缺少配置',
  invalid: '配置无效',
  'missing-sdk': '缺少运行依赖',
  'managed-elsewhere': '由独立进程管理',
  'not-registered': '尚未注册',
};
const sources: Record<string, string> = {
  'server-environment': 'Server 环境配置（只读）',
  'web-environment': 'Web 环境配置（只读）',
  'runtime-registration': 'Server 运行时注册（只读）',
  'runtime-snapshot': '当前 Server 运行快照',
};
export default function ConnectionsPage() {
  const { t, localeTag } = useAdminI18n();
  const { hasPermission } = usePermission();
  const [data, setData] = useState<Connection[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0),
    [checkedAt, setCheckedAt] = useState('');
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [settingsError, setSettingsError] = useState(false);
  const [selected, setSelected] = useState<ConnectionProfile | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  function refresh() {
    setLoading(true);
    setRetry((value) => value + 1);
  }
  async function open(id: string) {
    setOpening(id);
    try {
      setSelected(
        await httpClient.get<ConnectionProfile>(
          `/management/connection-settings/${encodeURIComponent(id)}`,
        ),
      );
      setSettingsError(false);
    } catch {
      setSettingsError(true);
    } finally {
      setOpening(null);
    }
  }
  useEffect(() => {
    let active = true;
    void httpClient
      .get<{ connections: Connection[]; checkedAt: string }>('/management/connections')
      .then((result) => {
        if (!active) return;
        setData(result.connections);
        setCheckedAt(result.checkedAt);
        setError(false);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void httpClient
      .get<ConnectionSettings>('/management/connection-settings')
      .then((result) => {
        if (!active) return;
        setProfiles(result.profiles);
        setSettingsError(false);
      })
      .catch(() => {
        if (active) {
          setProfiles([]);
          setSettingsError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [retry]);
  const columns: ProColumns<Connection>[] = [
    { title: t('连接'), dataIndex: 'name', width: 180, renderText: (value) => t(value) },
    { title: t('用途'), dataIndex: 'category', width: 90, renderText: (value) => t(value) },
    {
      title: t('本地状态'),
      dataIndex: 'status',
      width: 155,
      render: (_, row) => (
        <Tag
          color={
            row.status === 'configured'
              ? 'success'
              : ['missing', 'invalid', 'missing-sdk'].includes(row.status)
                ? 'warning'
                : 'default'
          }
        >
          {t(states[row.status] ?? '未知')}
        </Tag>
      ),
    },
    {
      title: t('配置来源'),
      dataIndex: 'source',
      width: 210,
      renderText: (value) => t(sources[value] ?? value),
    },
    {
      title: t('生效版本'),
      key: 'revision',
      width: 160,
      render: (_, row) => {
        const profile = profiles.find((profile) => profile.id === row.id);
        const current = profile ?? row;
        return current.appliedRevision === undefined ? (
          '—'
        ) : (
          <Space direction="vertical" size={4}>
            <span>
              {t('运行 {applied} / 保存 {stored}', 'Applied {applied} / saved {stored}', {
                applied: current.appliedRevision,
                stored: current.storedRevision ?? 0,
              })}
            </span>
            {current.pendingRestart && <Tag color="warning">{t('待重启 Server')}</Tag>}
          </Space>
        );
      },
    },
    {
      title: t('配置概况'),
      key: 'configuration',
      render: (_, row) => (
        <Space direction="vertical" size={4}>
          {row.mode && (
            <span>
              {t('模式：')}
              {row.mode}
            </span>
          )}
          {row.configuredOfferCount !== undefined && (
            <span>
              {t('配置套餐：')}
              {row.configuredOfferCount}
            </span>
          )}
          {row.sdkAvailable !== null && (
            <span>
              {t('本地运行依赖：')}
              {row.sdkAvailable ? t('可用') : t('未安装')}
            </span>
          )}
          {row.missing.length > 0 && (
            <span>
              {t('缺项：')}
              {row.missing.map((key) => (
                <Tag key={key}>{key}</Tag>
              ))}
            </span>
          )}
          {row.registeredProviderIds && (
            <span>
              {t('已注册：')}
              {row.registeredProviderIds.join('、') || t('无')}
            </span>
          )}
          {row.configurationSourceIds && (
            <span>
              {t('配置源：')}
              {row.configurationSourceIds.join('、') || t('无')}
            </span>
          )}
          <Typography.Text type="secondary">{t(row.note)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('操作'),
      key: 'actions',
      width: 120,
      render: (_, row) => {
        const profile = profiles.find((profile) => profile.id === row.id);
        return profile ? (
          <Button
            type="link"
            loading={opening === row.id}
            disabled={opening !== null && opening !== row.id}
            onClick={() => void open(row.id)}
          >
            {hasPermission('config:update') && profile.canSave ? t('编辑配置') : t('查看配置')}
          </Button>
        ) : (
          '—'
        );
      },
    },
  ];
  return (
    <PageContainer title={t('连接配置')} extra={<Button onClick={refresh}>{t('刷新')}</Button>}>
      <Alert
        type="info"
        showIcon
        message={t('查看运行状态，管理下一次启动的连接配置')}
        description={t(
          '状态来自当前 Server 运行快照与本地依赖检查，不能证明凭据有效或外部服务连通。配置加密保存后需重启 Server 生效；网站分析、广告与客服通过公开配置接口交给 Web。密钥不会回显，页面不发送外部验证请求。',
        )}
        style={{ marginBottom: 20 }}
      />
      {error && (
        <Alert
          type="error"
          showIcon
          message={t('连接状态读取失败')}
          description={t('请确认配置查看权限与服务连接；下面可能保留上次成功读取的结果。')}
          style={{ marginBottom: 20 }}
        />
      )}
      {settingsError && (
        <Alert
          type="error"
          showIcon
          message={t('可保存配置读取失败')}
          description={t('当前无法打开配置编辑器。可刷新重试，运行状态仍独立展示。')}
          style={{ marginBottom: 20 }}
        />
      )}
      <ProTable<Connection>
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={[
          ...data,
          ...profiles
            .filter((profile) => !data.some((row) => row.id === profile.id))
            .map((profile) => ({
              id: profile.id,
              name: profile.name,
              category: profile.category,
              source: 'runtime-snapshot',
              status: 'unknown',
              enabled: null,
              missing: [],
              sdkAvailable: null,
              note: t('运行状态未能读取；可查看已保存配置。'),
            })),
        ]}
        search={false}
        pagination={false}
        options={false}
        scroll={{ x: 1200 }}
        headerTitle={
          checkedAt
            ? t('读取时间：{time}', 'Read at: {time}', {
                time: new Date(checkedAt).toLocaleString(localeTag),
              })
            : t('连接概况')
        }
      />
      {selected && (
        <ConnectionEditor
          key={`${selected.id}:${selected.storedRevision}`}
          profile={selected}
          writable={hasPermission('config:update')}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            refresh();
          }}
        />
      )}
    </PageContainer>
  );
}
