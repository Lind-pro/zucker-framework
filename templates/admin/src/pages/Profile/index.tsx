import React, { useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { ProForm, ProFormText } from '@ant-design/pro-components';
import { Card, Tabs, Avatar, Typography, Tag, Space, message, Descriptions } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons';
import httpClient from '@/lib/http-client';

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
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    httpClient.get<UserProfile>('/authorize/me').then(setProfile).catch(() => {});
  }, []);

  return (
    <PageContainer title="个人中心">
      <Card style={{ marginBottom: 24 }}>
        <Space size={24} align="start">
          <Avatar size={72} icon={<UserOutlined />} style={{ backgroundColor: '#4338CA' }} />
          <div>
            <Title level={4} style={{ marginBottom: 4 }}>
              {profile?.name || profile?.username || '加载中...'}
            </Title>
            <Text type="secondary">{profile?.email || '未设置邮箱'}</Text>
            <div style={{ marginTop: 8 }}>
              {profile?.roles?.map((role) => (
                <Tag key={role.id} color="blue">{role.name}</Tag>
              )) || <Tag>加载中</Tag>}
            </div>
          </div>
        </Space>
      </Card>

      <Card>
        <Tabs
          items={[
            {
              key: 'info',
              label: '基本信息',
              children: (
                <div style={{ maxWidth: 500 }}>
                  {profile && (
                    <>
                      <Descriptions column={1} style={{ marginBottom: 24 }}>
                        <Descriptions.Item label="用户名">{profile.username}</Descriptions.Item>
                        <Descriptions.Item label="注册时间">
                          {profile.createTime ? new Date(profile.createTime).toLocaleString('zh-CN') : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="最近登录">
                          {profile.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString('zh-CN') : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="登录次数">{profile.loginCount ?? 0}</Descriptions.Item>
                      </Descriptions>

                      <ProForm
                        initialValues={{ name: profile.name, email: profile.email }}
                        onFinish={async (values) => {
                          await httpClient.put('/authorize/me', values);
                          message.success('信息更新成功');
                          setProfile((prev) => prev ? { ...prev, ...values } : prev);
                        }}
                        layout="vertical"
                      >
                        <ProFormText
                          name="name"
                          label="姓名"
                          rules={[{ required: true, message: '请输入姓名' }]}
                          fieldProps={{ prefix: <UserOutlined /> }}
                        />
                        <ProFormText
                          name="email"
                          label="邮箱"
                          rules={[{ type: 'email', message: '请输入有效的邮箱' }]}
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
              label: '修改密码',
              children: (
                <div style={{ maxWidth: 400 }}>
                  <ProForm
                    onFinish={async (values) => {
                      if (values.newPassword !== values.confirmPassword) {
                        message.error('两次输入的密码不一致');
                        return false;
                      }
                      await httpClient.post('/authorize/change-password', {
                        oldPassword: values.oldPassword,
                        newPassword: values.newPassword,
                      });
                      message.success('密码修改成功');
                      return true;
                    }}
                    layout="vertical"
                  >
                    <ProFormText.Password
                      name="oldPassword"
                      label="当前密码"
                      rules={[{ required: true, message: '请输入当前密码' }]}
                      fieldProps={{ prefix: <LockOutlined /> }}
                    />
                    <ProFormText.Password
                      name="newPassword"
                      label="新密码"
                      rules={[
                        { required: true, message: '请输入新密码' },
                        { min: 8, message: '密码至少 8 位' },
                      ]}
                      fieldProps={{ prefix: <LockOutlined /> }}
                    />
                    <ProFormText.Password
                      name="confirmPassword"
                      label="确认新密码"
                      rules={[{ required: true, message: '请再次输入新密码' }]}
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
