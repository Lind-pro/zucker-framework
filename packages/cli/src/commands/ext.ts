import { Command } from 'commander';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { extname, join, resolve } from 'path';
import { frameworkCheckoutRoot } from './checkout';

/**
 * `zucker ext` reads ext-kit artifacts and the extension template from a framework source checkout
 * (`<root>/packages/cli/dist`). An installed CLI does not ship them, so it refuses instead of
 * resolving paths inside `node_modules`.
 */
function checkoutPaths(runtimeDirectory: string = __dirname) {
  const root = frameworkCheckoutRoot(runtimeDirectory);
  if (!root) {
    throw new Error('`zucker ext` only runs from a zucker-framework source checkout (packages/cli/dist); the published CLI does not bundle the extension template or ext-kit artifacts.');
  }
  const kitDir = join(root, 'packages', 'ext-kit');
  return {
    root,
    templateDir: join(root, 'templates', 'extension'),
    // vendored 基建文件：sync 时逐个刷新（CSS/HTML 属于每个扩展的设计层，不在此列）
    vendored: [
      { from: join(kitDir, 'dist', 'ext-kit.js'), to: 'lib/ext-kit.js' },
      { from: join(kitDir, 'dist', 'ext-kit-popup.js'), to: 'lib/ext-kit-popup.js' },
      { from: join(kitDir, 'assets', 'offscreen.html'), to: 'offscreen.html' },
      { from: join(kitDir, 'assets', 'offscreen.js'), to: 'offscreen.js' },
      { from: join(kitDir, 'assets', 'package.mjs'), to: 'scripts/package.mjs' },
    ],
  };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** Validate free-text options: one line, bounded length (Chrome limits name 75 / description 132). */
export function validateExtensionText(label: string, value: string, max: number): string {
  if (!value.trim() || value.length > max || CONTROL.test(value)) {
    throw new Error(`--${label} must be a single line of 1-${max} characters.`);
  }
  return value;
}

export function validateExtensionColor(label: string, value: string): string {
  if (!COLOR.test(value)) throw new Error(`--${label} must be a #rrggbb colour.`);
  return value;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/**
 * Escape a placeholder value for the file it is written into. Placeholders in .json/.js/.mjs sit
 * inside double-quoted strings (or line comments), so they are JSON-string escaped; HTML is entity
 * escaped; CSS only carries validated colours plus the brand in a comment. Returns null for files
 * that are not substituted (binary or unknown assets are copied byte for byte).
 */
export function escapeForFile(file: string, value: string): string | null {
  switch (extname(file).toLowerCase()) {
    case '.json':
    case '.js':
    case '.mjs':
      return JSON.stringify(value).slice(1, -1).replace(/</g, '\\u003c');
    case '.html':
      return escapeHtml(value);
    case '.css':
      return value.replace(/\*\//g, '* /').replace(/[<>]/g, '');
    case '.md':
    case '.txt':
      return value;
    default:
      return null;
  }
}

export function substitutePlaceholders(file: string, content: string, replacements: ReadonlyArray<[string, string]>): string | null {
  if (escapeForFile(file, '') === null) return null;
  let result = content;
  for (const [placeholder, value] of replacements) result = result.split(placeholder).join(escapeForFile(file, value)!);
  return result;
}

function syncVendored(extDir: string, vendored: ReadonlyArray<{ from: string; to: string }>): string[] {
  const updated: string[] = [];
  for (const file of vendored) {
    if (!existsSync(file.from)) {
      throw new Error(`Kit artifact missing: ${file.from} — run \`pnpm --filter @zucker-framework/ext-kit build\` first.`);
    }
    const dest = join(extDir, file.to);
    mkdirSync(join(dest, '..'), { recursive: true });
    const next = readFileSync(file.from);
    const prev = existsSync(dest) ? readFileSync(dest) : null;
    if (!prev || !prev.equals(next)) {
      writeFileSync(dest, next);
      updated.push(file.to);
    }
  }
  return updated;
}

function isExtensionDir(dir: string): boolean {
  return existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'lib', 'ext-kit.js'));
}

const createCommand = new Command('create')
  .description('Scaffold a new browser extension on top of @zucker-framework/ext-kit')
  .argument('<slug>', 'Product slug, lowercase (e.g. "sampleext") — storage keys & server product id')
  .option('--name <name>', 'Store display name (e.g. "Sample Extension")')
  .option('--brand <brand>', 'Brand word (e.g. "Sample") — folder prefix, wordmark')
  .option('--desc <desc>', 'Store description')
  .option('--accent <color>', 'Accent color', '#7c8cff')
  .option('--accent-deep <color>', 'Deep accent color', '#5a6cf0')
  .option('--badge <color>', 'Badge background color', '#4353d9')
  .option('--dir <dir>', 'Target directory (default: <slug>-extension)')
  .action((slug: string, options: Record<string, string>) => {
    if (!/^[a-z][a-z0-9]{0,39}$/.test(slug)) {
      throw new Error('slug must be lowercase alphanumeric (max 40), e.g. "sampleext".');
    }
    const { templateDir, vendored } = checkoutPaths();
    const brand = validateExtensionText('brand', options.brand || slug.charAt(0).toUpperCase() + slug.slice(1), 40);
    const name = validateExtensionText('name', options.name || `${brand} Extension`, 75);
    const desc = validateExtensionText('desc', options.desc || `${brand} browser extension.`, 132);
    const accent = validateExtensionColor('accent', options.accent);
    const accentDeep = validateExtensionColor('accent-deep', options.accentDeep);
    const badge = validateExtensionColor('badge', options.badge);
    const targetDir = resolve(process.cwd(), options.dir || `${slug}-extension`);
    if (lstatSync(targetDir, { throwIfNoEntry: false })) {
      throw new Error(`Directory already exists: ${targetDir}`);
    }
    if (!existsSync(templateDir)) {
      throw new Error(`Template not found: ${templateDir}`);
    }

    cpSync(templateDir, targetDir, { recursive: true });

    // 占位符替换
    const repls: Array<[string, string]> = [
      ['__EXT_NAME__', name],
      ['__EXT_DESC__', desc],
      ['__EXT_BRAND__', brand],
      ['__EXT_PREFIX__', slug.toUpperCase()],
      ['__EXT_SLUG__', slug],
      ['__EXT_ACCENT_DEEP__', accentDeep],
      ['__EXT_ACCENT__', accent],
      ['__EXT_BADGE_COLOR__', badge],
    ];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else {
          // Only known text files are rewritten; anything else stays byte-identical.
          const content = substitutePlaceholders(p, readFileSync(p, 'utf8'), repls);
          if (content !== null) writeFileSync(p, content);
        }
      }
    };
    walk(targetDir);

    const updated = syncVendored(targetDir, vendored);

    console.log(`\n  Created ${targetDir}`);
    console.log(`  Vendored: ${updated.join(', ')}`);
    console.log('\n  Next steps:');
    console.log('  1. Implement capture() in background.js (default: full-page screenshot).');
    console.log('  2. Adjust popup settings fields in popup/popup.html + popup.js.');
    console.log('  3. Add icons/ and the manifest icons field.');
    console.log(`  4. Register product "${slug}" on the licensing server + create a Stripe Payment Link.\n`);
  });

const syncCommand = new Command('sync')
  .description('Refresh vendored ext-kit artifacts (lib/ext-kit*.js, offscreen, package script) in extensions')
  .argument('[dirs...]', 'Extension directories (default: scan cwd + direct children)')
  .action((dirs: string[]) => {
    const { vendored } = checkoutPaths();
    let targets = (dirs || []).map((d) => resolve(process.cwd(), d));
    if (!targets.length) {
      const cwd = process.cwd();
      targets = isExtensionDir(cwd)
        ? [cwd]
        : readdirSync(cwd)
            .map((entry) => join(cwd, entry))
            .filter((p) => statSync(p).isDirectory() && isExtensionDir(p));
    }
    if (!targets.length) {
      throw new Error('No extension directories found (need manifest.json + lib/ext-kit.js).');
    }
    for (const dir of targets) {
      if (!isExtensionDir(dir)) {
        console.log(`  Skipped (not an ext-kit extension): ${dir}`);
        continue;
      }
      const updated = syncVendored(dir, vendored);
      console.log(`  ${dir}: ${updated.length ? `updated ${updated.join(', ')}` : 'already up to date'}`);
    }
  });

// 服务端核心（@zucker-framework/ext-server）以 TS 源码 vendored 进消费方 NestJS 项目：
// 消费方 CI/Docker 构建拿不到本仓库，npm 也未发布，源码随项目一起编译。
const SERVER_FILES = ['core.ts', 'stripe.ts', 'types.ts'];
const SERVER_BANNER =
  '// AUTO-GENERATED from zucker-framework packages/ext-server — DO NOT EDIT.\n' +
  '// 修改请改框架源码后运行 `zucker ext sync-server <dir>` 重新分发。\n';

/**
 * Plan a vendored server sync. Every existing destination must already carry the AUTO-GENERATED
 * banner; otherwise nothing is written, so an application's own `types.ts` is never replaced.
 */
export function planServerSync(target: string, sources: ReadonlyArray<{ name: string; content: string }>) {
  const writes: Array<{ dest: string; name: string; content: string }> = [];
  const foreign: string[] = [];
  for (const source of sources) {
    const dest = join(target, source.name);
    const content = SERVER_BANNER + source.content;
    const stat = lstatSync(dest, { throwIfNoEntry: false });
    if (stat) {
      const previous = stat.isFile() ? readFileSync(dest, 'utf8') : '';
      if (!stat.isFile() || !previous.startsWith(SERVER_BANNER.split('\n')[0])) {
        foreign.push(source.name);
        continue;
      }
      if (previous === content) continue;
    }
    writes.push({ dest, name: source.name, content });
  }
  return { writes, foreign };
}

const syncServerCommand = new Command('sync-server')
  .description('Vendor @zucker-framework/ext-server sources (core/stripe/types) into a NestJS app directory')
  .argument('<dir>', 'Target directory (e.g. apps/server/src/extension/core)')
  .action((dir: string) => {
    const { root } = checkoutPaths();
    const target = resolve(process.cwd(), dir);
    const sources = SERVER_FILES.map((name) => {
      const src = join(root, 'packages', 'ext-server', 'src', name);
      if (!existsSync(src)) throw new Error(`Missing ${src}`);
      return { name, content: readFileSync(src, 'utf8') };
    });
    const plan = planServerSync(target, sources);
    if (plan.foreign.length) {
      throw new Error(`Refusing to overwrite files without the AUTO-GENERATED banner in ${target}: ${plan.foreign.join(', ')}. Use an empty or previously vendored directory.`);
    }
    mkdirSync(target, { recursive: true });
    const updated: string[] = [];
    for (const write of plan.writes) {
      writeFileSync(write.dest, write.content);
      updated.push(write.name);
    }
    console.log(`  ${target}: ${updated.length ? `updated ${updated.join(', ')}` : 'already up to date'}`);
    console.log('  Reminder: prisma 片段见 packages/ext-server/assets/extension-product.prisma（手动并入消费方 schema）');
  });

export const extCommand = new Command('ext')
  .description('Browser extension scaffolding & vendored kit management')
  .addCommand(createCommand)
  .addCommand(syncCommand)
  .addCommand(syncServerCommand);
