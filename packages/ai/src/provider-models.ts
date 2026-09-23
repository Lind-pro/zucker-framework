import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** @experimental Account-visible provider catalogue; never a pricing or capability guarantee. */
export interface ProviderModelConnection {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  proxyHost?: string;
  proxyPort?: number;
}
export interface AvailableProviderModel {
  id: string;
  name: string;
}

function endpoint(connection: ProviderModelConnection): URL {
  const defaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    claude: 'https://api.anthropic.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  };
  const base = connection.baseUrl?.trim() || defaults[connection.provider.toLowerCase()];
  if (!base) throw new Error('Custom providers require a Base URL');
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid provider Base URL');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url;
}

async function readPage(
  url: URL,
  headers: Record<string, string>,
  connection: ProviderModelConnection,
  signal: AbortSignal,
): Promise<unknown> {
  let agent: RequestOptions['agent'];
  if (connection.proxyHost) {
    if (
      !/^[a-zA-Z0-9.\-]+$/.test(connection.proxyHost) ||
      typeof connection.proxyPort !== 'number' ||
      !Number.isInteger(connection.proxyPort) ||
      connection.proxyPort < 1 ||
      connection.proxyPort > 65535
    )
      throw new Error('Invalid proxy configuration');
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    agent = new HttpsProxyAgent(`http://${connection.proxyHost}:${connection.proxyPort}`);
  } else if (connection.proxyPort) throw new Error('Proxy host is required');
  return new Promise((resolve, reject) => {
    // Native requests intentionally do not follow redirects with credentials.
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { headers, agent, signal },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Provider model list returned HTTP ${res.statusCode ?? 0}`));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            req.destroy(new Error('Provider model list is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => reject(new Error('Provider model list response interrupted')));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Invalid provider model list response'));
          }
        });
      },
    );
    req.on('error', () => reject(new Error('Provider model list request failed or timed out')));
    req.end();
  });
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** @experimental Lists actual provider IDs using the supplied connection, without an inference call. */
export async function listProviderModels(
  connection: ProviderModelConnection,
): Promise<AvailableProviderModel[]> {
  if (!connection.apiKey?.trim()) throw new Error('API Key is required');
  const url = endpoint(connection);
  const provider = connection.provider.toLowerCase();
  const anthropic = provider === 'claude' || provider === 'anthropic';
  const gemini = provider === 'gemini' && !/\/openai\/models$/.test(url.pathname);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (anthropic) {
    headers['x-api-key'] = connection.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    url.searchParams.set('limit', '1000');
  } else if (gemini) {
    headers['x-goog-api-key'] = connection.apiKey;
    url.searchParams.set('pageSize', '1000');
  } else headers.Authorization = `Bearer ${connection.apiKey}`;
  const signal = AbortSignal.timeout(20_000);
  const models = new Map<string, AvailableProviderModel>();
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const body = await readPage(url, headers, connection, signal);
    if (!record(body)) throw new Error('Invalid provider model list response');
    const entries = gemini ? body.models : body.data;
    if (!Array.isArray(entries)) throw new Error('Invalid provider model list response');
    for (const item of entries) {
      if (!record(item)) throw new Error('Invalid provider model entry');
      const rawId = gemini ? item.name : item.id;
      if (typeof rawId !== 'string' || !rawId.trim())
        throw new Error('Invalid provider model identifier');
      const id = gemini ? rawId.replace(/^models\//, '') : rawId;
      const name = anthropic ? item.display_name : gemini ? item.displayName : item.id;
      models.set(id, { id, name: typeof name === 'string' && name ? name : id });
    }
    const cursor =
      anthropic && body.has_more ? body.last_id : gemini ? body.nextPageToken : undefined;
    if (!cursor) {
      if (anthropic && body.has_more) throw new Error('Invalid provider model pagination');
      return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    if (typeof cursor !== 'string' || cursors.has(cursor))
      throw new Error('Invalid provider model pagination');
    cursors.add(cursor);
    url.searchParams.set(anthropic ? 'after_id' : 'pageToken', cursor);
  }
  throw new Error('Provider model list exceeds pagination limit');
}
