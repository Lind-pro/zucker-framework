import { Command } from 'commander';
import { Pool } from 'pg';
import {
  AIAccessProviderRegistry,
  PostgresCredentialProfileStore,
  type CredentialProfile,
  type CredentialProfileStore,
} from '@zucker/ai-access';
import { createOpenAICodexAccessProvider } from '@zucker/ai-access/openai-codex';

interface AIStoreResource {
  store: CredentialProfileStore;
  close(): Promise<void>;
}

interface AICommandDependencies {
  registry?: AIAccessProviderRegistry;
  createStore?: (databaseUrl: string) => Promise<AIStoreResource>;
  env?: NodeJS.ProcessEnv;
  write?: (message: string) => void;
}

interface ProfileOptions {
  profile: string;
}

interface LoginOptions extends ProfileOptions {
  method?: string;
}

interface ImportOptions extends ProfileOptions {
  fromFile: string;
}

interface SmokeOptions extends ProfileOptions {
  model: string;
  input: string;
}

export function createAICommand(dependencies: AICommandDependencies = {}): Command {
  const registry = dependencies.registry ?? createDefaultRegistry();
  const createStore = dependencies.createStore ?? createPostgresStore;
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? ((message: string) => process.stdout.write(`${message}\n`));
  const line = (message = '') => write(message);
  const withStore = async <T>(operation: (store: CredentialProfileStore) => Promise<T>): Promise<T> => {
    const resource = await createStore(requiredDatabaseUrl(env));
    try {
      await resource.store.ensureSchema?.();
      return await operation(resource.store);
    } finally {
      await resource.close();
    }
  };

  const providersCommand = new Command('providers')
    .description('列出已安装的 AI Provider')
    .action(() => {
      for (const provider of registry.list()) {
        const auth = provider.authMethods.map((method) => method.id).join(', ') || '无';
        const sources = provider.credentialSources.map((source) => source.id).join(', ') || '无';
        line(`${provider.id}  ${provider.name}`);
        line(`  认证方式：${auth}`);
        line(`  凭据来源：${sources}`);
      }
    });

  const storeCommand = new Command('store')
    .description('管理 AI Profile 存储')
    .addCommand(
      new Command('init')
        .description('初始化 PostgreSQL Profile 表')
        .action(async () => {
          await withStore(async () => undefined);
          line('AI Profile 存储已初始化。');
        }),
    );

  const loginCommand = new Command('login')
    .description('登录 AI Provider 并保存 Profile')
    .argument('<provider>', 'Provider ID')
    .option('--profile <name>', 'Profile 名称', 'default')
    .option('--method <method>', '认证方式 ID')
    .action(async (providerId: string, options: LoginOptions) => {
      const provider = registry.get(providerId);
      const method = options.method
        ? provider.authMethods.find((candidate) => candidate.id === options.method)
        : provider.authMethods[0];
      if (!method) throw new Error(`Provider ${providerId} 不支持指定的认证方式。`);
      await withStore(async (store) => {
        await method.login({
          store,
          profileName: options.profile,
          onVerification: (verification) => {
            line(`请打开：${verification.verificationUrl}`);
            line(`并输入设备码：${verification.userCode}`);
          },
        });
      });
      line(`Provider ${providerId} 的 Profile ${options.profile} 已登录。`);
    });

  const statusCommand = new Command('status')
    .description('查看已保存的 AI Profile，不显示凭据内容')
    .argument('[provider]', 'Provider ID')
    .action(async (providerId?: string) => {
      if (providerId) registry.get(providerId);
      const profiles = await withStore((store) => store.list(providerId));
      if (profiles.length === 0) {
        line('没有已保存的 AI Profile。');
        return;
      }
      for (const profile of profiles) line(formatProfileStatus(profile));
    });

  const importCommand = new Command('import')
    .description('从文件导入 Provider Profile')
    .argument('<provider>', 'Provider ID')
    .requiredOption('--from-file <path>', '凭据文件路径')
    .option('--profile <name>', 'Profile 名称', 'default')
    .action(async (providerId: string, options: ImportOptions) => {
      const provider = registry.get(providerId);
      const source = provider.credentialSources.find((candidate) => candidate.kind === 'file');
      if (!source) throw new Error(`Provider ${providerId} 不支持从文件导入 Profile。`);
      const profiles = await source.discover({
        profileName: options.profile,
        location: options.fromFile,
      });
      await withStore(async (store) => {
        for (const profile of profiles) {
          if (profile.providerId !== providerId) {
            throw new Error(`凭据源返回了错误的 Provider：${profile.providerId}`);
          }
          await store.save(profile);
        }
      });
      line(`已导入 ${profiles.length} 个 ${providerId} Profile。`);
    });

  const profileCommand = new Command('profile')
    .description('管理 AI Profile')
    .addCommand(importCommand);

  const smokeCommand = new Command('smoke')
    .description('使用指定 Profile 发起一次最小真实请求')
    .argument('<provider>', 'Provider ID')
    .requiredOption('--model <model>', '模型名称')
    .option('--profile <name>', 'Profile 名称', 'default')
    .option('--input <text>', '测试输入', '请只回复：连接成功')
    .action(async (providerId: string, options: SmokeOptions) => {
      const provider = registry.get(providerId);
      const result = await withStore((store) => provider.runtime.complete(
        {
          model: options.model,
          input: options.input,
          reasoningEffort: 'low',
          textVerbosity: 'low',
        },
        { store, profileName: options.profile },
      ));
      line(result.content.trim());
      line(`Token：输入 ${result.tokenUsage.input}，输出 ${result.tokenUsage.output}，合计 ${result.tokenUsage.total}`);
    });

  return new Command('ai')
    .description('管理 AI Provider、认证 Profile 与调用验证')
    .addCommand(providersCommand)
    .addCommand(storeCommand)
    .addCommand(loginCommand)
    .addCommand(statusCommand)
    .addCommand(profileCommand)
    .addCommand(smokeCommand);
}

function createDefaultRegistry(): AIAccessProviderRegistry {
  const registry = new AIAccessProviderRegistry();
  registry.register(createOpenAICodexAccessProvider());
  return registry;
}

async function createPostgresStore(databaseUrl: string): Promise<AIStoreResource> {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    store: new PostgresCredentialProfileStore({ pool }),
    close: () => pool.end(),
  };
}

function requiredDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const databaseUrl = env.AI_ACCESS_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('请设置 AI_ACCESS_DATABASE_URL 或 DATABASE_URL 后再使用 AI Profile。');
  }
  return databaseUrl;
}

function formatProfileStatus(profile: CredentialProfile): string {
  const expiresAt = profile.expiresAt;
  const status = expiresAt && expiresAt <= Date.now() ? '已过期，可尝试自动刷新' : '可用';
  const expiry = expiresAt ? new Date(expiresAt).toISOString() : '长期有效';
  return `${profile.providerId}/${profile.profileName}  ${status}  认证=${profile.authMethod}  到期=${expiry}`;
}
