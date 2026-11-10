import { AI_CONNECTIONS, validateAIConnection } from '../../ai-connections/ai-connections.config';
import { connectionField, defineConnectionProfile } from '../registry';

const { boolean, secret, text } = connectionField;
/** Native AI connections; the AI module builds its clients once at startup. */
export const AI_CONNECTION_PROFILES = AI_CONNECTIONS.map(connection => defineConnectionProfile({
  applyMode: 'restart',
  profile: { id: connection.id, name: connection.name, category: 'AI', fields: [
    boolean(`${connection.prefix}_ENABLED`, '启用'), secret(`${connection.prefix}_API_KEY`, 'API 密钥'), text(`${connection.prefix}_MODEL_ID`, '模型 ID'),
    { key: `${connection.prefix}_BASE_URL`, label: 'API 地址', type: 'url', defaultValue: connection.baseURL, description: 'HTTPS 地址，不含用户名、查询参数或片段；兼容接口必须明确填写。' },
    { key: `${connection.prefix}_MAX_TOKENS`, label: '最大输出 Token', type: 'number', min: 1, max: 1048576, description: 'Anthropic 必填；其他连接可由具体调用声明。仍需遵循所选模型的限制。' },
    { key: `${connection.prefix}_TIMEOUT_MS`, label: '超时（毫秒）', type: 'number', defaultValue: '60000', min: 1, max: 600000 },
  ] },
  validate: env => validateAIConnection(connection.id, env),
}));
