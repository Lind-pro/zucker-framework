import { useAdminI18n } from '@/i18n';
import { useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, App, Button, Card, Form, Input, Select, Space, Tabs } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';

type LinkValue = { label: string; href: string };
interface SiteSettings {
  name: string;
  theme: string;
  appearance: 'light' | 'dark' | 'system';
  description: { zh: string; en: string };
  navigation: { zh: LinkValue[]; en: LinkValue[] };
  footerLinks: { zh: LinkValue[]; en: LinkValue[] };
}
function LinkEditor({
  field,
  locale,
  label,
}: {
  field: 'navigation' | 'footerLinks';
  locale: 'zh' | 'en';
  label: string;
}) {
  const { t } = useAdminI18n();
  return (
    <Card size="small" title={label} style={{ marginBottom: 20 }}>
      <Form.List name={[field, locale]}>
        {(fields, { add, remove }) => (
          <Space direction="vertical" style={{ width: '100%' }}>
            {fields.map((item) => (
              <Space key={item.key} align="start" wrap>
                <Form.Item name={[item.name, 'label']} rules={[{ required: true, max: 80 }]}>
                  <Input
                    aria-label={t('{label}名称 {index}', '{label} label {index}', {
                      label,
                      index: item.name + 1,
                    })}
                    placeholder={t('链接名称')}
                  />
                </Form.Item>
                <Form.Item name={[item.name, 'href']} rules={[{ required: true }]}>
                  <Input
                    aria-label={t('{label}地址 {index}', '{label} URL {index}', {
                      label,
                      index: item.name + 1,
                    })}
                    placeholder={t('/about 或 https://…')}
                    style={{ width: 300, maxWidth: '100%' }}
                  />
                </Form.Item>
                <Button
                  aria-label={t('删除{label} {index}', 'Delete {label} {index}', {
                    label,
                    index: item.name + 1,
                  })}
                  icon={<DeleteOutlined />}
                  onClick={() => remove(item.name)}
                />
              </Space>
            ))}
            <Button
              icon={<PlusOutlined />}
              disabled={fields.length >= 12}
              onClick={() => add({ label: '', href: '' })}
            >
              {t('添加链接')}
            </Button>
          </Space>
        )}
      </Form.List>
    </Card>
  );
}
export default function SiteSettingsPage() {
  const { t } = useAdminI18n();
  const { message } = App.useApp(),
    [form] = Form.useForm<SiteSettings>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [saving, setSaving] = useState(false),
    [retry, setRetry] = useState(0),
    [defaults, setDefaults] = useState(false);
  useEffect(() => {
    let active = true;
    void httpClient
      .get<{ settings: SiteSettings; usingDefaults: boolean }>('/content/manage/settings')
      .then((result) => {
        if (!active) return;
        form.setFieldsValue(result.settings);
        setDefaults(result.usingDefaults);
        setError(false);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [form, retry]);
  return (
    <PageContainer title={t('站点配置')}>
      <p style={{ marginTop: 0, marginBottom: 20, opacity: 0.75 }}>
        {t('维护公开网站的品牌、双语链接与默认外观，保存后刷新网站即可生效。')}
      </p>
      <Alert
        type="info"
        showIcon
        message={t('配置生效范围')}
        description={t(
          '本页只修改公开站点品牌、双语链接与默认外观。账户、邮件、支付和存储连接由各自的部署配置管理，不在这里提供未接通的开关。',
        )}
        style={{ marginBottom: 20 }}
      />
      {error ? (
        <Alert
          type="error"
          showIcon
          message={t('站点配置加载失败')}
          description={t('请确认内容管理权限与服务连接。')}
          action={
            <Button
              onClick={() => {
                setLoading(true);
                setRetry((value) => value + 1);
              }}
            >
              {t('重试')}
            </Button>
          }
        />
      ) : (
        <Card loading={loading}>
          {defaults && (
            <Alert
              type="info"
              message={t('当前使用默认站点设置；保存后将写入数据库。')}
              style={{ marginBottom: 20 }}
            />
          )}
          <Form
            name="site-settings"
            form={form}
            layout="vertical"
            disabled={saving}
            onFinish={async (values) => {
              setSaving(true);
              try {
                await httpClient.put('/content/manage/settings', values);
                setDefaults(false);
                message.success(t('站点配置已保存'));
              } catch {
                message.error(t('保存失败，请检查链接格式、字段长度或权限。'));
              } finally {
                setSaving(false);
              }
            }}
            style={{ maxWidth: 900 }}
          >
            <Form.Item name="name" label={t('网站名称')} rules={[{ required: true, max: 100 }]}>
              <Input />
            </Form.Item>
            <Space align="start" wrap>
              <Form.Item
                name="theme"
                label={t('命名主题')}
                rules={[{ required: true }]}
                extra={t('当前提供 default 主题；未知主题由公开站点安全回退。')}
              >
                <Input style={{ width: 220 }} />
              </Form.Item>
              <Form.Item name="appearance" label={t('默认外观')} rules={[{ required: true }]}>
                <Select
                  style={{ width: 220 }}
                  options={[
                    { value: 'light', label: t('浅色') },
                    { value: 'dark', label: t('深色') },
                    { value: 'system', label: t('跟随系统') },
                  ]}
                />
              </Form.Item>
            </Space>
            <Tabs
              items={(['zh', 'en'] as const).map((locale) => ({
                key: locale,
                label: locale === 'zh' ? t('中文') : 'English',
                forceRender: true,
                children: (
                  <>
                    <Form.Item
                      name={['description', locale]}
                      label={t('站点简介')}
                      rules={[{ max: 500 }]}
                    >
                      <Input.TextArea rows={3} />
                    </Form.Item>
                    <LinkEditor field="navigation" locale={locale} label={t('导航链接')} />
                    <LinkEditor field="footerLinks" locale={locale} label={t('页脚链接')} />
                  </>
                ),
              }))}
            />
            <PermissionGuard permission="content:manage">
              <Button type="primary" htmlType="submit" loading={saving}>
                {t('保存站点配置')}
              </Button>
            </PermissionGuard>
          </Form>
        </Card>
      )}
    </PageContainer>
  );
}
