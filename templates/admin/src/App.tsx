import React from 'react';
import { RouterProvider } from 'react-router/dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import { ProConfigProvider, enUSIntl, zhCNIntl } from '@ant-design/pro-components';
import zhCN from 'antd/es/locale/zh_CN';
import enUS from 'antd/es/locale/en_US';
import { AdminLocaleProvider, useAdminI18n } from './i18n';
import router from './router';
import { getThemeConfig } from './config/theme';
import useThemeStore from './stores/useThemeStore';

const App: React.FC = () => {
  const themeMode = useThemeStore((s) => s.themeMode);
  const { locale } = useAdminI18n();

  return (
    <AdminLocaleProvider>
      <ConfigProvider theme={getThemeConfig(themeMode)} locale={locale === 'zh' ? zhCN : enUS}>
        <AntdApp>
          <ProConfigProvider intl={locale === 'zh' ? zhCNIntl : enUSIntl}>
            <RouterProvider router={router} />
          </ProConfigProvider>
        </AntdApp>
      </ConfigProvider>
    </AdminLocaleProvider>
  );
};

export default App;
