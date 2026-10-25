import { useAdminI18n } from '@/i18n';
import React, { useEffect, useState } from 'react';
import { PageContainer, ProForm, ProFormText } from '@ant-design/pro-components';
import {
  App as AntdApp,
  Card,
  Tabs,
  Avatar,
  Typography,
  Tag,
  Space,
  Descriptions,
  Alert,
  Button,
  Skeleton,
} from 'antd';
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons';
import httpClient, { accountPublicClient } from '@/lib/http-client';
import { useNavigate } from 'react-router';
import useAuthStore from '@/stores/useAuthStore';

const { Title, Text } = Typography;

interface UserProfile {
  id: string;
  username: string;
  name?: string;
  email?: string;
  roles?: Array<{ id: string; name: string }>;
  createTime?: string;
  lastLoginAt?: string;
  loginCount?: number;
}

const ProfilePage: React.FC = () => {
  const { t, localeTag } = useAdminI18n();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(false),
    [retry, setRetry] = useState(0);
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    void httpClient
      .get<UserProfile>('/authorize/me')
      .then((result) => {
        if (!result || typeof result.id !== 'string' || typeof result.username !== 'string')
          throw new Error('Invalid profile response');
        if (active) setProfile(result);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retry]);

  if (loading)
    return (
      <PageContainer title={t('个人中心')}>
        <Card aria-label={t('正在加载个人资料', 'Loading your profile')}>
          <Skeleton active />
        </Card>
      </PageContainer>
    );
  if (loadError || !profile)
    return (
      <PageContainer title={t('个人中心')}>
        <Alert
          type="error"
          showIcon
          message={t('个人资料读取失败', 'Could not load your profile')}
          description={t(
            '请检查连接并重试。未读取到资料不代表账户信息为空。',
            'Check your connection and try again. A failed read does not mean your account details are empty.',
          )}
          action={<Button onClick={() => setRetry((value) => value + 1)}>{t('重试')}</Button>}
        />
      </PageContainer>
    );

  return (
    <PageContainer title={t('个人中心')}>
      <Card style={{ marginBottom: 24 }}>
        <Space size={24} align="start">
          <Avatar size={72} icon={<UserOutlined />} style={{ backgroundColor: '#4338CA' }} />
          <div>
            <Title level={4} style={{ marginBottom: 4 }}>
              {profile?.name || profile?.username || t('加载中...')}
            </Title>
            <Text type="secondary">{profile?.email || t('未设置邮箱')}</Text>
            <div style={{ marginTop: 8 }}>
              {profile?.roles?.map((role) => (
                <Tag key={role.id} color="blue">
                  {role.name}
                </Tag>
              )) || (profile ? null : <Tag>{t('加载中')}</Tag>)}
            </div>
          </div>
        </Space>
      </Card>

      <Card>
        <Tabs
          items={[
            {
              key: 'info',
              label: t('基本信息'),
              children: (
                <div style={{ maxWidth: 500 }}>
                  {profile && (
                    <>
                      <Descriptions column={1} style={{ marginBottom: 24 }}>
                        <Descriptions.Item label={t('用户名')}>
                          {profile.username}
                        </Descriptions.Item>
                        <Descriptions.Item label={t('注册时间')}>
                          {profile.createTime
                            ? new Date(profile.createTime).toLocaleString(localeTag)
                            : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label={t('最近登录')}>
                          {profile.lastLoginAt
                            ? new Date(profile.lastLoginAt).toLocaleString(localeTag)
                            : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label={t('登录次数')}>
                          {profile.loginCount ?? '-'}
                        </Descriptions.Item>
                      </Descriptions>

                      <ProForm
                        name="profile-details"
                        initialValues={{ name: profile.name, email: profile.email }}
                        onFinish={async (values) => {
                          try {
                            const name = String(values.name).trim();
                            const result = await httpClient.post<{ success: boolean }>(
                              '/authorize/profile',
                              { name },
                            );
                            if (result.success !== true)
                              throw new Error('Unexpected profile response');
                            setProfile((prev) => (prev ? { ...prev, name } : prev));
                            useAuthStore.getState().updateUser({ name });
                            message.success(t('信息更新成功'));
                            return true;
                          } catch {
                            message.error(t('信息更新失败，请稍后重试'));
                            return false;
                          }
                        }}
                        layout="vertical"
                      >
                        <ProFormText
                          name="name"
                          label={t('姓名')}
                          rules={[{ required: true, message: t('请输入姓名') }]}
                          fieldProps={{ prefix: <UserOutlined /> }}
                        />
                        <ProFormText
                          name="email"
                          label={t('邮箱')}
                          disabled
                          rules={[{ type: 'email', message: t('请输入有效的邮箱') }]}
                          fieldProps={{ prefix: <MailOutlined /> }}
                        />
                      </ProForm>
                    </>
                  )}
                </div>
              ),
            },
            {
              key: 'password',
              label: t('修改密码'),
              children: (
                <div style={{ maxWidth: 400 }}>
                  <ProForm
                    name="profile-password"
                    onFinish={async (values) => {
                      if (values.newPassword !== values.confirmPassword) {
                        message.error(t('两次输入的密码不一致'));
                        return false;
                      }
                      try {
                        await httpClient.get('/authorize/me');
                        const result = await accountPublicClient.post<{ success: boolean }>(
                          '/authorize/password',
                          {
                            currentPassword: values.oldPassword,
                            password: values.newPassword,
                          },
                          undefined,
                          {
                            headers: {
                              Authorization: `Bearer ${useAuthStore.getState().token ?? ''}`,
                            },
                          },
                        );
                        if (result.success !== true)
                          throw new Error('Unexpected password response');
                        useAuthStore.getState().logout();
                        message.success(t('密码修改成功，请重新登录'));
                        navigate('/login');
                        return true;
                      } catch {
                        message.error(t('密码修改失败，请检查当前密码并重试'));
                        return false;
                      }
                    }}
                    layout="vertical"
                  >
                    <ProFormText.Password
                      name="oldPassword"
                      label={t('当前密码')}
                      rules={[{ required: true, message: t('请输入当前密码') }]}
                      fieldProps={{ prefix: <LockOutlined /> }}
                    />
                    <ProFormText.Password
                      name="newPassword"
                      label={t('新密码')}
                      extra={t('至少 8 位，包含大写字母、小写字母和数字')}
                      rules={[
                        { required: true, message: t('请输入新密码') },
                        { min: 8, message: t('密码至少 8 位') },
                      ]}
                      fieldProps={{ prefix: <LockOutlined /> }}
                    />
                    <ProFormText.Password
                      name="confirmPassword"
                      label={t('确认新密码')}
                      rules={[{ required: true, message: t('请再次输入新密码') }]}
                      fieldProps={{ prefix: <LockOutlined /> }}
                    />
                  </ProForm>
                </div>
              ),
            },
          ]}
        />
      </Card>
    </PageContainer>
  );
};

export default ProfilePage;
