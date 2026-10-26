import { useAdminI18n, LanguageSwitcher } from '@/i18n';
import React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LoginForm, ProFormText } from '@ant-design/pro-components';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntdApp } from 'antd';
import useAuthStore from '@/stores/useAuthStore';
import httpClient, { accountPublicClient } from '@/lib/http-client';

interface LoginResult {
  userId: string;
  token: string;
  expires?: number;
}

interface MePermission {
  id: string;
  name: string;
  actions: string[];
}

interface MeResult {
  id: string;
  username: string;
  name?: string;
  permissions: MePermission[];
  attributes?: Record<string, unknown>;
}

const LoginPage: React.FC = () => {
  const { t } = useAdminI18n();

  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [searchParams] = useSearchParams();
  const { setAuthState } = useAuthStore();

  const handleSubmit = async (values: { username: string; password: string }) => {
    let issued = false;
    try {
      const loginResult = await accountPublicClient.post<LoginResult>('/authorize/login', values);
      if (!loginResult.token) throw new Error('Missing access token');
      issued = true;
      useAuthStore.getState().updateToken(loginResult.token);
      const meResult = await httpClient.get<MeResult>('/authorize/me');

      const permissions = meResult.permissions.flatMap((p) =>
        p.id === '*' || p.id === 'superadmin' ? [p.id] : p.actions.map((a) => `${p.id}:${a}`),
      );
      setAuthState({
        token: useAuthStore.getState().token || loginResult.token,
        user: {
          id: meResult.id,
          username: meResult.username,
          name: meResult.name,
          ...meResult.attributes,
        },
        permissions,
      });

      message.success(t('登录成功'));
      const raw = searchParams.get('redirect') || '/dashboard';
      const redirect = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';
      navigate(redirect);
      return true;
    } catch {
      if (issued) useAuthStore.getState().logout();
      message.error(t('登录失败，请检查账号密码或稍后重试'));
      return false;
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: '#F7F8FA',
      }}
    >
      <div style={{ position: 'absolute', top: 20, right: 20 }}>
        <LanguageSwitcher />
      </div>
      <LoginForm
        submitter={{ searchConfig: { submitText: t('登录') } }}
        title={t('管理后台')}
        subTitle={t('请输入账号和密码登录')}
        onFinish={handleSubmit}
      >
        <ProFormText
          name="username"
          fieldProps={{ size: 'large', prefix: <UserOutlined /> }}
          placeholder={t('用户名')}
          rules={[{ required: true, message: t('请输入用户名') }]}
        />
        <ProFormText.Password
          name="password"
          fieldProps={{ size: 'large', prefix: <LockOutlined /> }}
          placeholder={t('密码')}
          rules={[{ required: true, message: t('请输入密码') }]}
        />
      </LoginForm>
    </div>
  );
};

export default LoginPage;
