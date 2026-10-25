import { useAdminI18n } from '@/i18n';
import { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import httpClient from '@/lib/http-client';
import type { ConnectionField, ConnectionProfile } from './types';

type Action = 'keep' | 'replace' | 'clear';
interface Edit {
  action: Action;
  value?: string;
}
const sources = {
  saved: '已保存',
  environment: '环境配置',
  default: '默认值',
  cleared: '已清除环境回退',
  unset: '未设置',
};

export default function ConnectionEditor({
  profile: initialProfile,
  writable,
  onClose,
  onSaved,
}: {
  profile: ConnectionProfile;
  writable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useAdminI18n();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [profile, setProfile] = useState(initialProfile);
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState(false);
  const editable = writable && profile.canSave;
  const fieldLabel = (field: ConnectionField) =>
    t(
      field.label,
      field.key.endsWith('_API_KEY') || field.key === 'STRIPE_SECRET_KEY' ? 'API key' : undefined,
    );
  const changed = Object.values(actions).some((action) => action !== 'keep');
  function control(field: ConnectionField) {
    const props = { autoComplete: 'off', maxLength: field.type === 'secret' ? 16384 : 2048 };
    if (field.type === 'secret') return <Input.Password {...props} autoComplete="new-password" />;
    if (field.type === 'boolean')
      return (
        <Select
          options={[
            { value: 'true', label: t('启用') },
            { value: 'false', label: t('关闭', 'Disabled') },
          ]}
        />
      );
    if (field.type === 'select')
      return <Select options={field.options?.map((value) => ({ value, label: value }))} />;
    return <Input {...props} inputMode={field.type === 'number' ? 'numeric' : undefined} />;
  }
  async function save() {
    let fields: Record<string, Edit>;
    try {
      fields = (await form.validateFields()).fields ?? {};
    } catch {
      return;
    }
    const values: Record<string, string | null> = {};
    const secrets: Record<string, { action: 'clear' } | { action: 'replace'; value: string }> = {};
    for (const field of profile.fields) {
      const edit = fields[field.key];
      if (!edit || edit.action === 'keep') continue;
      if (field.type === 'secret')
        secrets[field.key] =
          edit.action === 'clear' ? { action: 'clear' } : { action: 'replace', value: edit.value! };
      else values[field.key] = edit.action === 'clear' ? null : edit.value!;
    }
    setSaving(true);
    setFailed(false);
    try {
      const saved = await httpClient.put<ConnectionProfile>(
        `/management/connection-settings/${encodeURIComponent(profile.id)}`,
        {
          expectedRevision: profile.storedRevision,
          values,
          secrets,
        },
      );
      form.resetFields();
      message.success(
        saved.pendingRestart
          ? t('已加密保存，重启 Server 后生效')
          : t('配置已保存，当前运行版本未变化'),
      );
      onSaved();
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        for (const field of profile.fields.filter((field) => field.type === 'secret')) {
          form.setFieldValue(['fields', field.key, 'action'], 'keep');
          form.setFieldValue(['fields', field.key, 'value'], undefined);
        }
        setActions((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(([key]) =>
              profile.fields.some((field) => field.key === key && field.type !== 'secret'),
            ),
          ),
        );
        setConflict(true);
      } else setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  async function reload() {
    setSaving(true);
    try {
      setProfile(
        await httpClient.get<ConnectionProfile>(
          `/management/connection-settings/${encodeURIComponent(profile.id)}`,
        ),
      );
      setConflict(false);
      setFailed(false);
      message.info(t('已读取最新版本；保留非密钥草稿，请核对后再保存。密钥修改需重新选择。'));
    } catch {
      message.error(t('最新配置读取失败，请重试'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open
      title={t('{action}连接配置 · {name}', '{action} connection · {name}', {
        action: editable ? t('编辑') : t('查看'),
        name: t(profile.name),
      })}
      width={720}
      destroyOnHidden
      maskClosable={false}
      closable={!saving}
      keyboard={!saving}
      onCancel={() => {
        if (!saving) {
          form.resetFields();
          onClose();
        }
      }}
      footer={
        <Space wrap>
          <Button
            disabled={saving}
            onClick={() => {
              form.resetFields();
              onClose();
            }}
          >
            {editable ? t('取消') : t('关闭')}
          </Button>
          {conflict ? (
            <Button type="primary" loading={saving} onClick={() => void reload()}>
              {t('重新读取配置')}
            </Button>
          ) : (
            editable && (
              <Button
                type="primary"
                loading={saving}
                disabled={!changed}
                onClick={() => void save()}
              >
                {t('加密保存')}
              </Button>
            )
          )}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        message={t(
          '正在查看已保存配置：版本 {stored}；当前运行版本 {applied}',
          'Saved configuration version {stored}; running version {applied}',
          { stored: profile.storedRevision, applied: profile.appliedRevision },
        )}
        description={t(
          '保存后需重启 Server 才会应用。只检查本地配置组合，不发送外部请求。每项默认保持原值与来源；清除会屏蔽环境配置，使用该字段默认值（如有）。',
        )}
        style={{ marginBottom: 20 }}
      />
      {!profile.canSave && (
        <Alert
          type="warning"
          showIcon
          message={t('尚未配置独立的配置加密密钥，当前只能查看')}
          description={t(
            '由部署维护者设置独立于登录密钥的 CONFIG_ENCRYPTION_KEY（至少 32 个字符），重启 Server 后可保存。',
          )}
          style={{ marginBottom: 20 }}
        />
      )}
      {!writable && (
        <Alert type="info" message={t('当前账户只有配置查看权限')} style={{ marginBottom: 20 }} />
      )}
      {conflict && (
        <Alert
          type="warning"
          showIcon
          message={t('配置已被其他操作更新，请重新读取后再编辑')}
          description={t(
            '非密钥草稿已保留，密钥修改已清除。读取最新版本后请核对再保存，未覆盖其他人的更改。',
          )}
          style={{ marginBottom: 20 }}
        />
      )}
      {failed && (
        <Alert
          type="error"
          showIcon
          message={t('保存结果未确认')}
          description={t(
            '请核对必填配置、服务权限与连接。若请求已到达服务端，再次保存会受版本保护；可取消并重新读取确认已保存版本。',
          )}
          style={{ marginBottom: 20 }}
        />
      )}
      <Form form={form} layout="vertical" disabled={saving || conflict} autoComplete="off">
        {profile.fields.map((field) => (
          <div
            key={field.key}
            style={{
              marginBottom: 20,
              borderBottom: '1px solid rgba(128,128,128,0.18)',
              paddingBottom: 16,
            }}
          >
            <Space wrap style={{ marginBottom: 8 }}>
              <Typography.Text strong>{fieldLabel(field)}</Typography.Text>
              <Tag>{t(sources[field.source])}</Tag>
            </Space>
            <Typography.Paragraph
              style={{ marginBottom: 8, overflowWrap: 'anywhere' }}
              type="secondary"
            >
              {field.type === 'secret'
                ? field.configured
                  ? t('已配置，值不会显示')
                  : t('未配置')
                : (field.value ?? t('未设置'))}
              {field.description && (
                <>
                  <br />
                  {t(field.description)}
                </>
              )}
            </Typography.Paragraph>
            {editable && (
              <>
                <Form.Item
                  name={['fields', field.key, 'action']}
                  label={t('{label}操作', '{label} action', { label: fieldLabel(field) })}
                  initialValue="keep"
                  style={{ marginBottom: 8 }}
                >
                  <Select
                    onChange={(action: Action) => {
                      setActions((previous) => ({ ...previous, [field.key]: action }));
                      form.setFieldValue(
                        ['fields', field.key, 'value'],
                        action === 'replace' && field.type !== 'secret'
                          ? (field.value ?? undefined)
                          : undefined,
                      );
                    }}
                    options={[
                      { value: 'keep', label: t('保持原值与来源') },
                      {
                        value: 'replace',
                        label: field.type === 'secret' ? t('替换密钥') : t('修改值'),
                      },
                      { value: 'clear', label: t('清除（屏蔽环境回退）') },
                    ]}
                  />
                </Form.Item>
                {actions[field.key] === 'replace' && (
                  <Form.Item
                    name={['fields', field.key, 'value']}
                    label={t('{label}新值', '{label} new value', { label: fieldLabel(field) })}
                    preserve={false}
                    rules={[
                      {
                        required: true,
                        whitespace: true,
                        message: t('请输入新值；清除请使用明确的清除操作'),
                      },
                      ...(field.type === 'number'
                        ? [
                            {
                              validator: (_rule: unknown, value: unknown) => {
                                const number = Number(value);
                                return typeof value === 'string' &&
                                  /^\d+$/.test(value) &&
                                  Number.isSafeInteger(number) &&
                                  number >= (field.min ?? 1) &&
                                  number <= (field.max ?? Number.MAX_SAFE_INTEGER)
                                  ? Promise.resolve()
                                  : Promise.reject(new Error(t('请输入允许范围内的正整数')));
                              },
                            },
                          ]
                        : []),
                    ]}
                  >
                    {control(field)}
                  </Form.Item>
                )}
              </>
            )}
          </div>
        ))}
      </Form>
    </Modal>
  );
}
