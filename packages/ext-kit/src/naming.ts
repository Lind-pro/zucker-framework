export function sanitize(value: string): string {
  return String(value || '')
    .replace(/[\\/:*?"<>|#&=%]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
}

export function normalizeUrls(urls: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(urls) ? urls : []) {
    const value = String(raw || '').trim();
    if (!/^https?:\/\//i.test(value)) {
      continue;
    }
    let key = value;
    try {
      const parsed = new URL(value);
      // Fragments may identify distinct application routes; never silently merge them.
      key = parsed.toString();
    } catch {
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
    if (out.length >= 500) {
      break;
    }
  }
  return out;
}

export function sessionStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 输出文件夹名：整批同域名时以域名开头（代理给多个客户批量导出，一眼分清哪批是哪个站），
// 混合域名则仅用时间戳
export function folderNameFor(urls: string[]): string {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).hostname.replace(/^www\./, ''));
    } catch {
      // 跳过非法 url
    }
  }
  const stamp = sessionStamp();
  if (hosts.size === 1) {
    const host = sanitize([...hosts][0]).slice(0, 60);
    return host ? `${host}-${stamp}` : stamp;
  }
  return stamp;
}

// 用完整 URL 命名：host + 路径 + query，一眼对上是哪个页面（保留 query 以区分同路径不同参数）
export function urlBaseName(url: string, maxLength: number, includeQuery: boolean): string {
  let base = 'page';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    let rest = (parsed.pathname + (includeQuery ? parsed.search : '')).replace(/\/+$/, '');
    try {
      rest = decodeURIComponent(rest); // 让中文等 Unicode 路径保持可读，而非 %E5%85 乱码
    } catch {
      // 保留原样
    }
    base = host + rest;
  } catch {
    base = url;
  }
  return sanitize(base).slice(0, maxLength) || 'page';
}

export function buildBatchFileName(
  folder: string,
  item: { url: string; index: number },
  extension: string,
): string {
  const base = urlBaseName(item.url, 120, true);
  const index = String(item.index).padStart(3, '0');
  return `${folder}/${index}_${base}.${extension}`;
}

export function buildQuickFileName(
  brand: string,
  quickFolder: string,
  pageUrl: string,
  extension: string,
): string {
  const base = urlBaseName(pageUrl, 110, false);
  return `${brand}/${quickFolder}/${base}-${fileStamp()}.${extension}`;
}
