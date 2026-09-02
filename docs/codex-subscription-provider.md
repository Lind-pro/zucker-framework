# Codex 订阅 Provider

`@zucker/ai-access` 提供两条 Codex 订阅驱动：

- `OpenAICodexCliSubscriptionProvider`：默认推荐。通过 OpenAI 官方 `codex exec` 非交互模式使用独立 `CODEX_HOME` 中的 ChatGPT 登录，支持临时会话、JSONL、JSON Schema、取消和超时。
- `OpenAICodexSubscriptionProvider`：兼容实验实现。它参考 OpenClaw/Hermes 直连未公开的 ChatGPT Codex Responses 端点，不属于稳定官方 API，不作为生产默认通道。

两者只适用于可信、私有的服务端任务。它们不是 Platform API Key 的通用替代品，也不得暴露给不可信或公开用户。`@zucker/ai` 继续提供兼容重导出。

## 研究依据

实现前核对了以下固定提交：

- OpenClaw [`8d82e26`](https://github.com/openclaw/openclaw/tree/8d82e26e5f3460d40197ff9b4ddcf04117682547)：[OAuth Token](https://github.com/openclaw/openclaw/blob/8d82e26e5f3460d40197ff9b4ddcf04117682547/extensions/openai/openai-chatgpt-oauth-token.runtime.ts)、[设备码登录](https://github.com/openclaw/openclaw/blob/8d82e26e5f3460d40197ff9b4ddcf04117682547/extensions/openai/openai-chatgpt-device-code.ts)、[ChatGPT Responses](https://github.com/openclaw/openclaw/blob/8d82e26e5f3460d40197ff9b4ddcf04117682547/packages/ai/src/providers/openai-chatgpt-responses.ts)。
- Hermes Agent [`c693c77`](https://github.com/NousResearch/hermes-agent/tree/c693c772b55ba412da21405a230a5431353fd816)：[认证与刷新](https://github.com/NousResearch/hermes-agent/blob/c693c772b55ba412da21405a230a5431353fd816/hermes_cli/auth.py)、[Codex Transport](https://github.com/NousResearch/hermes-agent/blob/c693c772b55ba412da21405a230a5431353fd816/agent/transports/codex.py)、[Responses 适配](https://github.com/NousResearch/hermes-agent/blob/c693c772b55ba412da21405a230a5431353fd816/agent/codex_responses_adapter.py)。

两者共同采用设备码或 PKCE 登录、独立凭据存储、刷新令牌轮换、跨进程刷新锁、JWT 账户标识和 `store:false` Responses 请求。本实现保留这些必要能力，不引入多账号轮换、WebSocket、代理工具协议、推理状态回放或未公开的额度探测接口。

官方 OpenAI 文档同时说明：ChatGPT 登录可用于订阅访问，但程序化自动化优先使用 API Key，且不要把 Codex 执行暴露到不可信或公开环境。参见 [Authentication](https://learn.chatgpt.com/docs/auth) 与 [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)。

## 推荐：官方 Codex CLI 驱动

先为服务进程创建独立认证目录，不要与开发者日常使用的 `~/.codex` 共用：

```bash
CODEX_HOME=/secure/codex-service codex login --device-auth
CODEX_HOME=/secure/codex-service codex login status
```

认证目录包含访问令牌，必须像密码一样由专用系统用户和私密卷保护。运行时只传入明确白名单环境变量：

```typescript
import { OpenAICodexCliSubscriptionProvider } from '@zucker/ai-access/openai-codex';

const provider = new OpenAICodexCliSubscriptionProvider({
  executable: '/opt/codex/bin/codex',
  codexHome: '/secure/codex-service',
  workingDirectory: '/var/empty/codex-inference',
  environment: {
    PATH: '/usr/bin:/bin',
    CODEX_CA_CERTIFICATE: '/etc/ssl/corporate.pem',
  },
});
const client = await provider.createModel({
  modelId: 'gpt-5.6-luna',
  timeoutMs: 180_000,
});
const result = await client.complete({
  instructions: '只返回符合 schema 的结果。',
  input: '业务资料……',
  reasoningEffort: 'high',
  outputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false,
  },
});
```

该驱动要求 Codex CLI 0.152.0 或更高版本，并固定使用 `--ephemeral --ignore-user-config --ignore-rules --strict-config`，不加载个人插件、MCP 或项目规则。它使用自定义 permission profile，只让命令工具读取最小系统运行路径，拒绝读取工作区和认证目录，并关闭工具网络与 Web Search。Codex 自身访问 OpenAI 的认证/模型流量不受命令工具网络策略影响。

## 兼容实验驱动

```typescript
import { PostgresCredentialProfileStore } from '@zucker/ai-access';
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

- 官方 CLI 驱动不把 Token 导入 Framework 数据库；Profile 只保存 `CODEX_HOME` 外部引用。认证文件由 OpenAI CLI 原地刷新，运行环境必须持久化更新后的 `auth.json`。
- 兼容实验驱动可使用统一的 `ai_credential_profiles` 表。当前 OAuth JSON 为明文，因此只能用于本地验证；未接入业务侧加密 codec 前禁止保存生产订阅凭据。
- 文件仅用于导入旧版登录结果或测试，不作为生产默认存储。
- 官方 CLI 驱动要求专用 `CODEX_HOME`；兼容实验驱动不读取或覆盖 `~/.codex/auth.json`，避免两个刷新实现竞争单次 refresh token。
- access token 临近过期时提前两分钟刷新；刷新过程在进程内合并，并通过 PostgreSQL advisory lock 跨进程串行化。
- 429 被视为订阅额度或刷新限制，不要求重新登录；401、403、`invalid_grant`、`refresh_token_reused` 要求重新认证。
- 兼容实验 Provider 对目标地址执行严格白名单，只允许 OpenAI ChatGPT Codex HTTPS 端点，防止 Bearer Token 被自定义代理截获；端点属于未公开接口，随时可能变化。
- 公开产品流量继续使用 `OpenAIProvider` 和 Platform API Key。该 Provider 只应放在管理员白名单、内部评测或私有任务队列后面。
