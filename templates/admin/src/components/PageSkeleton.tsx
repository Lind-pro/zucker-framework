import React from 'react';
import { Card, Skeleton, Space } from 'antd';

const PageSkeleton: React.FC = () => (
  <div style={{ padding: 24 }}>
    <Card>
      <Space style={{ marginBottom: 16 }}>
        <Skeleton.Input active style={{ width: 200 }} />
        <Skeleton.Input active style={{ width: 200 }} />
        <Skeleton.Button active />
      </Space>
      <Skeleton active paragraph={{ rows: 8 }} />
    </Card>
  </div>
);

export default PageSkeleton;
