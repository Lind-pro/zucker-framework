import { useState } from 'react';
import { message } from 'antd';
import type { ActionType } from '@ant-design/pro-components';
import httpClient from '@/lib/http-client';
import { useAdminI18n } from '@/i18n';

/**
 * 批量删除 Hook — 提供 rowSelection 配置和批量删除函数。
 *
 * @param resource API 资源路径（如 '/users'）
 * @param actionRef ProTable 的 actionRef
 */
export function useBatchDelete(resource: string, actionRef: React.RefObject<ActionType | null>) {
  const { t } = useAdminI18n();
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys),
  };

  const batchDelete = async () => {
    if (selectedRowKeys.length === 0) {
      message.warning(t('请先选择要删除的记录', 'Select records to delete first.'));
      return;
    }

    const results = await Promise.allSettled(
      selectedRowKeys.map((id) => httpClient.delete(`${resource}/${id}`)),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;

    if (failed === 0) {
      message.success(
        t('成功删除 {count} 条记录', 'Deleted {count} records', { count: succeeded }),
      );
    } else {
      message.warning(
        t(
          '删除完成: {succeeded} 成功, {failed} 失败',
          'Deletion finished: {succeeded} succeeded, {failed} failed',
          { succeeded, failed },
        ),
      );
    }

    setSelectedRowKeys([]);
    actionRef.current?.reload();
  };

  const clearSelection = () => setSelectedRowKeys([]);

  return { selectedRowKeys, rowSelection, batchDelete, clearSelection };
}
