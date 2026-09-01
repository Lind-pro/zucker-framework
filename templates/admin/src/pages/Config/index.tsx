import React, { useEffect, useState } from 'react';
import {
  PageContainer,
  ProForm,
  ProFormText,
  ProFormTextArea,
  ProFormSwitch,
  ProFormDigit,
} from '@ant-design/pro-components';
import { Card, message } from 'antd';
import httpClient from '@/lib/http-client';

interface SystemConfig {
  siteName: string;
  siteDescription: string;
  enableRegistration: boolean;
  enableCaptcha: boolean;
  maxLoginAttempts: number;
  sessionTimeout: number;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword?: string;
}

const ConfigPage: React.FC = () => {
  const [initialValues, setInitialValues] = useState<SystemConfig>();

  useEffect(() => {
    httpClient.get<SystemConfig>('/config').then(setInitialValues).catch(() => {});
  }, []);

  return (
    <PageContainer title="系统配置">
      <Card>
        {initialValues !== undefined && (
          <ProForm<SystemConfig>
            initialValues={initialValues}
            onFinish={async (values) => {
              await httpClient.put('/config', values);
              message.success('保存成功');
            }}
            layout="vertical"
            style={{ maxWidth: 640 }}
          >
            <ProForm.Group title="基本设置">
              <ProFormText name="siteName" label="站点名称" rules={[{ required: true }]} width="lg" />
              <ProFormTextArea name="siteDescription" label="站点描述" width="lg" />
            </ProForm.Group>
            <ProForm.Group title="安全设置">
              <ProFormSwitch name="enableRegistration" label="开放注册" />
              <ProFormSwitch name="enableCaptcha" label="启用验证码" />
              <ProFormDigit name="maxLoginAttempts" label="最大登录尝试次数" width="sm" min={1} max={20} />
              <ProFormDigit name="sessionTimeout" label="会话超时（分钟）" width="sm" min={1} />
            </ProForm.Group>
            <ProForm.Group title="邮件设置">
              <ProFormText name="smtpHost" label="SMTP 主机" width="md" />
              <ProFormDigit name="smtpPort" label="SMTP 端口" width="sm" min={1} max={65535} />
              <ProFormText name="smtpUser" label="SMTP 用户名" width="md" />
              <ProFormText.Password name="smtpPassword" label="SMTP 密码" width="md" placeholder="留空则不修改" />
            </ProForm.Group>
          </ProForm>
        )}
      </Card>
    </PageContainer>
  );
};

export default ConfigPage;
