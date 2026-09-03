import React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LoginForm, ProFormText } from '@ant-design/pro-components';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { message } from 'antd';
import useAuthStore from '@/stores/useAuthStore';
import httpClient from '@/lib/http-client';

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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setAuthState } = useAuthStore();

  const handleSubmit = async (values: { username: string; password: string }) => {
    const loginResult = await httpClient.post<LoginResult>('/authorize/login', values);

    // 用临时 token 请求当前用户信息
    const meResult = await httpClient.get<MeResult>('/authorize/me', undefined, {
      headers: { Authorization: `Bearer ${loginResult.token}` },
    });

    // 将权限对象列表转换为 "resource:action" 格式的字符串数组
    const permissions = meResult.permissions.flatMap((p) =>
      p.actions.map((a) => `${p.id}:${a}`),
    );

    setAuthState({
      token: loginResult.token,
      user: { id: meResult.id, username: meResult.username, name: meResult.name, ...meResult.attributes },
      permissions,
    });

    message.success('登录成功');
    const raw = searchParams.get('redirect') || '/dashboard';
    const redirect = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';
    navigate(redirect);
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
      <LoginForm title="管理后台" subTitle="请输入账号和密码登录" onFinish={handleSubmit}>
        <ProFormText
          name="username"
          fieldProps={{ size: 'large', prefix: <UserOutlined /> }}
          placeholder="用户名"
          rules={[{ required: true, message: '请输入用户名' }]}
        />
        <ProFormText.Password
          name="password"
          fieldProps={{ size: 'large', prefix: <LockOutlined /> }}
          placeholder="密码"
          rules={[{ required: true, message: '请输入密码' }]}
        />
      </LoginForm>
    </div>
  );
};

export default LoginPage;
