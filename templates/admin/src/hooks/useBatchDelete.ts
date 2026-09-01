import { useState } from 'react';
import { message } from 'antd';
import type { ActionType } from '@ant-design/pro-components';
import httpClient from '@/lib/http-client';

/**
 * 批量删除 Hook — 提供 rowSelection 配置和批量删除函数。
 *
 * @param resource API 资源路径（如 '/users'）
 * @param actionRef ProTable 的 actionRef
 */
export function useBatchDelete(resource: string, actionRef: React.RefObject<ActionType | null>) {
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys),
  };

  const batchDelete = async () => {
    if (selectedRowKeys.length === 0) {
      message.warning('请先选择要删除的记录');
      return;
    }

    const results = await Promise.allSettled(
      selectedRowKeys.map((id) => httpClient.delete(`${resource}/${id}`)),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    if (failed === 0) {
      message.success(`成功删除 ${succeeded} 条记录`);
    } else {
      message.warning(`删除完成: ${succeeded} 成功, ${failed} 失败`);
    }

    setSelectedRowKeys([]);
    actionRef.current?.reload();
  };

  const clearSelection = () => setSelectedRowKeys([]);

  return { selectedRowKeys, rowSelection, batchDelete, clearSelection };
}
