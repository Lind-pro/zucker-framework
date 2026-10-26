import React from 'react';
import { Card, Skeleton, Space } from 'antd';

const PageSkeleton: React.FC = () => (
  <div style={{ padding: 24 }}>
    <Card>
      <Space wrap style={{ marginBottom: 16, maxWidth: '100%' }}>
        <Skeleton.Input active style={{ width: 200 }} />
        <Skeleton.Input active style={{ width: 200 }} />
        <Skeleton.Button active />
      </Space>
      <Skeleton active paragraph={{ rows: 8 }} />
    </Card>
  </div>
);

export default PageSkeleton;
