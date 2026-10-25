import { Result } from 'antd';
import { useAdminI18n } from '../i18n';
export default function DisabledFeature() {
  const { t } = useAdminI18n();
  return (
    <Result
      status="info"
      title={t('此功能尚未启用', 'This feature is not enabled')}
      subTitle={t(
        '当前消费者尚未为该模块配置持久化和管理契约。这里不会加载示例数据或发起业务请求。',
        'This application has not configured persistence and management for this module. No sample data or business requests are loaded here.',
      )}
    />
  );
}
