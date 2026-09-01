# Codex 订阅 Provider

`@zucker/ai-access` 提供 `openai-codex` Provider 插件，用于可信、私有的服务端任务通过 ChatGPT/Codex 订阅调用 Codex Responses。`@zucker/ai` 继续导出兼容 API。它不是 Platform API Key 的替代品，不应暴露给不可信或公开用户。

## 研究依据

实现前核对了以下固定提交：

- OpenClaw [`8d82e26`](https://github.com/openclaw/openclaw/tree/8d82e26e5f3460d40197ff9b4ddcf04117682547)：[OAuth Token](https://github.com/openclaw/openclaw/blob/8d82e26e5f3460d40197ff9b4ddcf04117682547/extensions/openai/openai-chatgpt-oauth-token.runtime.ts)、[设备码登录](https://github.com/openclaw/openclaw/blob/8d82e26e5f3460d40197ff9b4ddcf04117682547/extensions/openai/openai-chatgpt-device-code.ts)、[ChatGPT Responses](https://github.com/openclaw/openclaw/blob/8d82e26e5f3460d40197ff9b4ddcf04117682547/packages/ai/src/providers/openai-chatgpt-responses.ts)。
- Hermes Agent [`c693c77`](https://github.com/NousResearch/hermes-agent/tree/c693c772b55ba412da21405a230a5431353fd816)：[认证与刷新](https://github.com/NousResearch/hermes-agent/blob/c693c772b55ba412da21405a230a5431353fd816/hermes_cli/auth.py)、[Codex Transport](https://github.com/NousResearch/hermes-agent/blob/c693c772b55ba412da21405a230a5431353fd816/agent/transports/codex.py)、[Responses 适配](https://github.com/NousResearch/hermes-agent/blob/c693c772b55ba412da21405a230a5431353fd816/agent/codex_responses_adapter.py)。

两者共同采用设备码或 PKCE 登录、独立凭据存储、刷新令牌轮换、跨进程刷新锁、JWT 账户标识和 `store:false` Responses 请求。本实现保留这些必要能力，不引入多账号轮换、WebSocket、代理工具协议、推理状态回放或未公开的额度探测接口。

官方 OpenAI 文档同时说明：ChatGPT 登录可用于订阅访问，但程序化自动化优先使用 API Key，且不要把 Codex 执行暴露到不可信或公开环境。参见 [Authentication](https://learn.chatgpt.com/docs/auth) 与 [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)。

## 使用方式

```typescript
import {
  PostgresCredentialProfileStore,
} from '@zucker/ai-access';
import {
  CodexSubscriptionAuthClient,
  OpenAICodexSubscriptionProvider,
} from '@zucker/ai-access/openai-codex';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresCredentialProfileStore({ pool });
await store.ensureSchema();

const auth = new CodexSubscriptionAuthClient({ store });
await auth.loginWithDeviceCode({
  onVerification: async ({ verificationUrl, userCode }) => {
    await publishInternalVerificationPrompt({ verificationUrl, userCode });
  },
});

const provider = new OpenAICodexSubscriptionProvider({ store });
const client = await provider.createModel({
  apiKey: '',
  modelId: 'gpt-5.6-terra',
  timeoutMs: 180_000,
});

const result = await client.complete({
  instructions: '根据业务资料生成完整源码，只返回源码。',
  input: '业务资料……',
  reasoningEffort: 'high',
});
```

日常管理使用统一 CLI：

```bash
zucker ai providers
zucker ai store init
zucker ai login openai-codex
zucker ai status openai-codex
zucker ai profile import openai-codex --from-file .data/codex-subscription.json
zucker ai smoke openai-codex --model gpt-5.6-luna
```

## 安全与运行约束

- 生产默认使用统一的 `ai_credential_profiles` 表。MVP 中 OAuth JSON 为明文，因此数据库账号必须最小权限、禁止业务接口返回 `credential` 字段，并对备份设置同等级访问控制。
- 文件仅用于导入旧版登录结果或测试，不作为生产默认存储。
- 不读取或覆盖 `~/.codex/auth.json`，避免 Codex CLI 与服务进程竞争单次 refresh token。
- access token 临近过期时提前两分钟刷新；刷新过程在进程内合并，并通过 PostgreSQL advisory lock 跨进程串行化。
- 429 被视为订阅额度或刷新限制，不要求重新登录；401、403、`invalid_grant`、`refresh_token_reused` 要求重新认证。
- Provider 对目标地址执行严格白名单，只允许 OpenAI 官方 ChatGPT Codex HTTPS 端点，防止 Bearer Token 被自定义代理截获。
- 公开产品流量继续使用 `OpenAIProvider` 和 Platform API Key。该 Provider 只应放在管理员白名单、内部评测或私有任务队列后面。
