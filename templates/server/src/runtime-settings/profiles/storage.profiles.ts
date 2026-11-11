import { PRIVATE_FILES_CONNECTION_DESCRIPTOR } from '@zucker-framework/storage';
import { storageOptionsFromEnvironment } from '../../files/files.config';
import { connectionSdkAvailable } from '../connection-sdk';
import { defineConnectionProfile, localizeConnectionDescriptor } from '../registry';

const label = (text: string) => ({ label: text });
/**
 * Private file storage is hot: `PrivateStorageModule` routes every storage call to the client of the
 * current revision. Changing provider, endpoint or bucket while files exist needs
 * `acknowledgeDataLocationChange: true` (D14, `files/files.module.ts` `StorageLocationGuard`).
 */
export const STORAGE_CONNECTION_PROFILES = [
  defineConnectionProfile({ applyMode: 'hot',
    validate: env => {
      if (env.FILES_STORAGE_PROVIDER === 's3' && !connectionSdkAvailable('@zucker-framework/storage', '@aws-sdk/client-s3')) throw new Error('s3');
      storageOptionsFromEnvironment(env);
    },
    profile: localizeConnectionDescriptor(PRIVATE_FILES_CONNECTION_DESCRIPTOR, { name: '私有文件存储（S3 / R2）', category: '存储', fields: {
      FILES_STORAGE_PROVIDER: label('存储类型'), FILES_S3_BUCKET: label('Bucket'), FILES_S3_REGION: label('Region'), FILES_S3_ENDPOINT: label('兼容 S3 的 Endpoint'),
      FILES_S3_ACCESS_KEY_ID: label('Access Key ID'), FILES_S3_SECRET_ACCESS_KEY: label('Secret Access Key'),
      FILES_S3_FORCE_PATH_STYLE: label('使用 Path Style（留空时按 Endpoint 选择）') } }) }),
];
