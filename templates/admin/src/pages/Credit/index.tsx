import React, { useRef } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Tag } from 'antd';
import { queryRequest } from '@/lib/http-client';

interface CreditRecord {
  id: string;
  userId: string;
  username: string;
  type: 'income' | 'expense' | 'refund';
  amount: number;
  balance: number;
  description: string;
  createdAt: string;
}

const typeColorMap: Record<string, string> = { income: 'green', expense: 'red', refund: 'orange' };
const typeLabelMap: Record<string, string> = { income: '收入', expense: '支出', refund: '退款' };

const CreditPage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);

  const columns: ProColumns<CreditRecord>[] = [
    { title: '用户', dataIndex: 'username' },
    {
      title: '类型',
      dataIndex: 'type',
      valueEnum: { income: '收入', expense: '支出', refund: '退款' },
      render: (_, record) => (
        <Tag color={typeColorMap[record.type]}>{typeLabelMap[record.type]}</Tag>
      ),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      search: false,
      render: (_, record) => (
        <span style={{ color: record.amount >= 0 ? '#059669' : '#DC2626', fontVariantNumeric: 'tabular-nums' }}>
          {record.amount >= 0 ? '+' : ''}{record.amount}
        </span>
      ),
    },
    { title: '余额', dataIndex: 'balance', search: false },
    { title: '描述', dataIndex: 'description', search: false, ellipsis: true },
    { title: '时间', dataIndex: 'createdAt', valueType: 'dateTime', search: false },
  ];

  return (
    <PageContainer title="积分管理">
      <ProTable<CreditRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        request={(params) => queryRequest<CreditRecord>('/credit', params)}
      />
    </PageContainer>
  );
};

export default CreditPage;
