import React from 'react';
import { RouterProvider } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import router from './router';
import { getThemeConfig } from './config/theme';
import useThemeStore from './stores/useThemeStore';

const App: React.FC = () => {
  const themeMode = useThemeStore((s) => s.themeMode);

  return (
    <ConfigProvider theme={getThemeConfig(themeMode)} locale={zhCN}>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  );
};

export default App;
