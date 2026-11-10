import { storageOptionsFromEnvironment } from '../../files/files.config';
import { connectionSdkAvailable } from '../connection-sdk';
import { connectionField, defineConnectionProfile } from '../registry';

const { secret, select, text } = connectionField;
export const STORAGE_CONNECTION_PROFILES = [
  defineConnectionProfile({ applyMode: 'restart',
    validate: env => {
      if (env.FILES_STORAGE_PROVIDER === 's3' && !connectionSdkAvailable('@zucker-framework/storage', '@aws-sdk/client-s3')) throw new Error('s3');
      storageOptionsFromEnvironment(env);
    },
    profile: { id: 'private-files', name: '私有文件存储（S3 / R2）', category: '存储', fields: [select('FILES_STORAGE_PROVIDER', '存储类型', ['local', 's3'], 'local'),
      text('FILES_S3_BUCKET', 'Bucket'), { ...text('FILES_S3_REGION', 'Region'), defaultValue: 'us-east-1' }, { key: 'FILES_S3_ENDPOINT', label: '兼容 S3 的 Endpoint', type: 'url' },
      secret('FILES_S3_ACCESS_KEY_ID', 'Access Key ID'), secret('FILES_S3_SECRET_ACCESS_KEY', 'Secret Access Key'), { key: 'FILES_S3_FORCE_PATH_STYLE', label: '使用 Path Style（留空时按 Endpoint 选择）', type: 'boolean' }] } }),
];
