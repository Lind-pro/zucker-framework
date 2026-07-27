import { Command } from 'commander';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

// monorepo 根定位：__dirname 为 packages/cli/dist（tsup 单文件产物）→ cli → packages → 根
const monorepoRoot = resolve(__dirname, '..', '..', '..');
const kitDir = join(monorepoRoot, 'packages', 'ext-kit');
const templateDir = join(monorepoRoot, 'templates', 'extension');

// vendored 基建文件：sync 时逐个刷新（CSS/HTML 属于每个扩展的设计层，不在此列）
const VENDORED: Array<{ from: string; to: string }> = [
  { from: join(kitDir, 'dist', 'ext-kit.js'), to: 'lib/ext-kit.js' },
  { from: join(kitDir, 'dist', 'ext-kit-popup.js'), to: 'lib/ext-kit-popup.js' },
  { from: join(kitDir, 'assets', 'offscreen.html'), to: 'offscreen.html' },
  { from: join(kitDir, 'assets', 'offscreen.js'), to: 'offscreen.js' },
  { from: join(kitDir, 'assets', 'package.mjs'), to: 'scripts/package.mjs' },
];

function syncVendored(extDir: string): string[] {
  const updated: string[] = [];
  for (const file of VENDORED) {
    if (!existsSync(file.from)) {
      throw new Error(`Kit artifact missing: ${file.from} — run \`pnpm --filter @zucker/ext-kit build\` first.`);
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
  .description('Scaffold a new browser extension on top of @zucker/ext-kit')
  .argument('<slug>', 'Product slug, lowercase (e.g. "siteshots") — storage keys & server product id')
  .option('--name <name>', 'Store display name (e.g. "SiteShots - Batch Full Page Screenshot")')
  .option('--brand <brand>', 'Brand word (e.g. "SiteShots") — folder prefix, wordmark')
  .option('--desc <desc>', 'Store description')
  .option('--accent <color>', 'Accent color', '#7c8cff')
  .option('--accent-deep <color>', 'Deep accent color', '#5a6cf0')
  .option('--badge <color>', 'Badge background color', '#4353d9')
  .option('--dir <dir>', 'Target directory (default: <slug>-extension)')
  .action((slug: string, options: Record<string, string>) => {
    if (!/^[a-z][a-z0-9]*$/.test(slug)) {
      console.log('  \x1b[31mError:\x1b[0m slug must be lowercase alphanumeric, e.g. "siteshots".');
      process.exit(1);
    }
    const brand = options.brand || slug.charAt(0).toUpperCase() + slug.slice(1);
    const name = options.name || `${brand} Extension`;
    const desc = options.desc || `${brand} browser extension.`;
    const targetDir = resolve(process.cwd(), options.dir || `${slug}-extension`);
    if (existsSync(targetDir)) {
      console.log(`  \x1b[31mError:\x1b[0m Directory already exists: ${targetDir}`);
      process.exit(1);
    }
    if (!existsSync(templateDir)) {
      console.log(`  \x1b[31mError:\x1b[0m Template not found: ${templateDir}`);
      process.exit(1);
    }

    cpSync(templateDir, targetDir, { recursive: true });

    // 占位符替换
    const repls: Array<[string, string]> = [
      ['__EXT_NAME__', name],
      ['__EXT_DESC__', desc],
      ['__EXT_BRAND__', brand],
      ['__EXT_PREFIX__', slug.toUpperCase()],
      ['__EXT_SLUG__', slug],
      ['__EXT_ACCENT_DEEP__', options.accentDeep],
      ['__EXT_ACCENT__', options.accent],
      ['__EXT_BADGE_COLOR__', options.badge],
    ];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else {
          let content = readFileSync(p, 'utf8');
          for (const [a, b] of repls) {
            content = content.split(a).join(b);
          }
          writeFileSync(p, content);
        }
      }
    };
    walk(targetDir);

    const updated = syncVendored(targetDir);

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
      console.log('  No extension directories found (need manifest.json + lib/ext-kit.js).');
      process.exit(1);
    }
    for (const dir of targets) {
      if (!isExtensionDir(dir)) {
        console.log(`  Skipped (not an ext-kit extension): ${dir}`);
        continue;
      }
      const updated = syncVendored(dir);
      console.log(`  ${dir}: ${updated.length ? `updated ${updated.join(', ')}` : 'already up to date'}`);
    }
  });

export const extCommand = new Command('ext')
  .description('Browser extension scaffolding & vendored kit management')
  .addCommand(createCommand)
  .addCommand(syncCommand);
