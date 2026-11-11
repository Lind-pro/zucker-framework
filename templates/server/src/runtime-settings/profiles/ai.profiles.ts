import { AI_CONNECTION_DESCRIPTORS } from '@zucker-framework/ai';
import { AI_CONNECTIONS, validateAIConnection } from '../../ai-connections/ai-connections.config';
import { defineConnectionProfile, localizeConnectionDescriptor } from '../registry';

/**
 * Native AI connections, hot: the AI runtime (`ai-connections/ai-connection-runtime.ts`) rebuilds the
 * model configuration and media providers on the next read after a save; a call in progress keeps its own.
 */
export const AI_CONNECTION_PROFILES = AI_CONNECTIONS.map(connection => {
  const descriptor = AI_CONNECTION_DESCRIPTORS.find(row => row.profile.id === connection.id);
  if (!descriptor) throw new Error(`No AI connection descriptor for ${connection.id}`);
  const p = connection.prefix;
  return defineConnectionProfile({
    applyMode: 'hot',
    profile: localizeConnectionDescriptor(descriptor, { name: connection.name, category: 'AI', fields: {
      [`${p}_ENABLED`]: { label: '启用' }, [`${p}_API_KEY`]: { label: 'API 密钥' }, [`${p}_MODEL_ID`]: { label: '模型 ID' },
      [`${p}_BASE_URL`]: { label: 'API 地址', description: 'HTTPS 地址，不含用户名、查询参数或片段；兼容接口必须明确填写。' },
      [`${p}_MAX_TOKENS`]: { label: '最大输出 Token', description: 'Anthropic 必填；其他连接可由具体调用声明。仍需遵循所选模型的限制。' },
      [`${p}_TIMEOUT_MS`]: { label: '超时（毫秒）' },
    } }),
    validate: env => validateAIConnection(connection.id, env),
  });
});
