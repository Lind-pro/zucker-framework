import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './cli-entry.mjs';

/**
 * Generates `docs/templates/skills/page-builder/references/blocks.md` (the block catalogue shipped to
 * generated projects) from `packages/fe-site/src/content.ts`, so the skill cannot drift from the
 * validator: block types, per-type field allow-lists, optional headings and the numeric limits are
 * read from the source, and generation fails when a type or field has no description below.
 *
 *   node scripts/prepare-skill-block-catalogue.mjs           write the file
 *   node scripts/prepare-skill-block-catalogue.mjs --check   exit 1 when the committed file is stale
 */
export const CONTENT_SOURCE = 'packages/fe-site/src/content.ts';
export const CATALOGUE_PATH = 'docs/templates/skills/page-builder/references/blocks.md';

const quoted = (text) => [...text.matchAll(/'([^'\n]+)'/g)].map((match) => match[1]);
function section(source, pattern, label) {
  const match = pattern.exec(source);
  if (!match) throw new Error(`${CONTENT_SOURCE}: cannot find ${label}; update the catalogue generator.`);
  return match[1];
}
function fieldMap(body) {
  const fields = {};
  for (const match of body.matchAll(/(?:'([a-z-]+)'|([a-z][a-zA-Z]*)):\s*\[([^\]]*)\]/g)) {
    fields[match[1] ?? match[2]] = quoted(match[3]);
  }
  return fields;
}

/** Reads the validator's own declarations; throws when a declaration moved or changed shape. */
export function readBlockContract(source) {
  const v1 = quoted(section(source, /SITE_BLOCK_TYPES_V1 = Object\.freeze\(\[([\s\S]*?)\]/, 'SITE_BLOCK_TYPES_V1'));
  const allBody = section(source, /SITE_BLOCK_TYPES: readonly SiteBlockType\[\] = Object\.freeze\(\[([\s\S]*?)\]/, 'SITE_BLOCK_TYPES');
  if (!allBody.includes('...SITE_BLOCK_TYPES_V1')) throw new Error(`${CONTENT_SOURCE}: SITE_BLOCK_TYPES no longer extends version 1.`);
  const types = [...v1, ...quoted(allBody)];
  const fieldsV1 = fieldMap(section(source, /const FIELDS_V1[^=]*= \{([\s\S]*?)\n\};/, 'FIELDS_V1'));
  const v2Body = section(source, /const FIELDS_V2[^=]*= \{([\s\S]*?)\n\};/, 'FIELDS_V2');
  if (!v2Body.includes('...FIELDS_V1')) throw new Error(`${CONTENT_SOURCE}: FIELDS_V2 no longer extends FIELDS_V1.`);
  const fields = { ...fieldsV1, ...fieldMap(v2Body) };
  const optionalHeading = quoted(section(source, /const OPTIONAL_HEADING[^=]*= new Set\(\[([^\]]*)\]\)/, 'OPTIONAL_HEADING'));
  const limits = {};
  for (const match of section(source, /SITE_CONTENT_LIMITS = Object\.freeze\(\{([\s\S]*?)\}\)/, 'SITE_CONTENT_LIMITS')
    .matchAll(/([a-zA-Z0-9]+):\s*(\d+)/g)) limits[match[1]] = Number(match[2]);
  for (const type of types) if (!fields[type]) throw new Error(`${CONTENT_SOURCE}: no field list for block type ${type}.`);
  return { types, v1, fields, optionalHeading, limits };
}

/**
 * Hand-written meaning of every type-specific field. `{name}` is replaced with SITE_CONTENT_LIMITS.name.
 * Item-level text limits that are literals inside the validator are written here; `content:check`
 * remains the authority and reports the exact field path when one is exceeded.
 */
const DESCRIPTIONS = {
  hero: {
    summary: 'Top-of-page pitch with up to two buttons.',
    fields: {
      text: 'optional supporting text, up to {text} characters',
      action: 'optional primary button `{ "label", "href" }` (label up to {label})',
      secondaryAction: 'optional second button, same shape as `action`',
      variant: '`"centered"` (default) or `"split"` (text beside `image`)',
      image: 'optional image (see Links and images)',
    },
  },
  markdown: {
    summary: 'Free text. Markdown is rendered with HTML disabled.',
    fields: { markdown: 'required Markdown text, up to {blockMarkdown} characters' },
  },
  features: {
    summary: 'Feature grid or list.',
    fields: {
      items: 'up to {featureItems} items `{ "title" (required, 160), "text" (required, {text}) }`',
      variant: '`"grid"` (default) or `"list"`',
      image: 'optional image shown beside the list',
    },
  },
  faq: {
    summary: 'Questions and answers.',
    fields: { items: 'up to {faqItems} items `{ "question" (required, 300), "answer" (required, {text}) }`' },
  },
  cta: {
    summary: 'Call to action with one required button.',
    fields: {
      text: 'optional text, up to {text} characters',
      action: 'required button `{ "label", "href" }`',
    },
  },
  links: {
    summary: 'A list of links.',
    fields: { items: 'up to {linkItems} items `{ "label" (required, {label}), "href" }`' },
  },
  'logo-cloud': {
    summary: 'Customer or partner logos. Use only logos you have permission to show.',
    fields: { items: 'up to {logoItems} items `{ "name" (required, 120), "image" (required), "href" (optional) }`' },
  },
  stats: {
    summary: 'Headline numbers. `value` is display text ("99.9%", "10k+"), never computed.',
    fields: {
      text: 'optional text, up to {text} characters',
      items: 'up to {statItems} items `{ "value" (required, 32), "label" (required, 120) }`',
    },
  },
  steps: {
    summary: 'Numbered how-it-works steps.',
    fields: {
      text: 'optional text, up to {text} characters',
      items: 'up to {stepItems} items `{ "title" (required, 160), "text" (required, {text}) }`',
    },
  },
  testimonials: {
    summary: 'Quotes. Only real quotes from real customers, with their permission; never invent them.',
    fields: {
      items: 'up to {testimonialItems} items `{ "quote" (required, 1200), "author" (required, 120), "role" (optional, 160), "avatar" (optional image) }`',
    },
  },
  showcase: {
    summary: 'Cards with an image each (examples, use cases, screenshots).',
    fields: {
      text: 'optional text, up to {text} characters',
      items: 'up to {showcaseItems} items `{ "title" (required, 160), "text" (optional, 1000), "image" (required), "href" (optional) }`',
    },
  },
  pricing: {
    summary: 'Plans and credit packs from the billing catalogue. Never write prices, currencies or credits here: the site reads them from the plans edited in the admin.',
    fields: {
      text: 'optional text, up to {text} characters',
      plans: '`"all"` or a list of up to {pricingPlans} unique plan slugs (lowercase, `[a-z0-9_-]`)',
      showCreditPacks: '`true` to list credit packs as well (default `false`)',
    },
  },
  newsletter: {
    summary: 'A plain POST form with one `email` field. The starter ships no newsletter endpoint: point it at one you own.',
    fields: {
      text: 'optional text, up to {text} characters',
      formAction: 'required: an `https://` URL or a same-origin path such as `/api/newsletter`',
      emailLabel: 'required field label, up to {label} characters',
      buttonLabel: 'required button label, up to {label} characters',
    },
  },
  'blog-list': {
    summary: 'Latest blog posts (filled in by the site).',
    fields: {
      text: 'optional text, up to {text} characters',
      limit: 'integer 1 to {blogListLimit} (default 3)',
      category: 'optional blog category slug',
    },
  },
  changelog: {
    summary: 'Latest changelog entries (filled in by the site).',
    fields: {
      text: 'optional text, up to {text} characters',
      limit: 'integer 1 to {changelogLimit} (default 5)',
    },
  },
  media: {
    summary: 'One image or video.',
    fields: {
      kind: 'required: `"image"` or `"video"`',
      src: 'required link to the file (see Links and images)',
      alt: 'required description, up to {imageAlt} characters (also the video\'s accessible name)',
      caption: 'optional caption, up to 500 characters',
      poster: 'optional poster image link for a video',
      width: 'optional integer 1 to {imageDimension}',
      height: 'optional integer 1 to {imageDimension}',
    },
  },
};

export function renderBlockCatalogue(source) {
  const contract = readBlockContract(source);
  const fill = (text) => text.replace(/\{([a-zA-Z0-9]+)\}/g, (_, name) => {
    if (contract.limits[name] === undefined) throw new Error(`Unknown limit {${name}} in the catalogue descriptions.`);
    return String(contract.limits[name]);
  });
  const described = Object.keys(DESCRIPTIONS);
  const missing = contract.types.filter((type) => !described.includes(type));
  const stale = described.filter((type) => !contract.types.includes(type));
  if (missing.length || stale.length) {
    throw new Error(`Block catalogue out of date: undescribed ${missing.join(', ') || '-'}; removed ${stale.join(', ') || '-'}.`);
  }
  const L = contract.limits;
  const lines = [
    '# Landing block catalogue',
    '',
    '<!-- Generated from @zucker-framework/fe-site (content.ts) by the framework\'s',
    '     scripts/prepare-skill-block-catalogue.mjs. Do not edit by hand. -->',
    '',
    'The block document format validated by `validateSiteDocument` (version 2). Every page file and',
    'every document saved in the admin goes through the same validator; `content:check` runs it over',
    '`apps/server/content` and prints the exact field path of each problem.',
    '',
    '## Document',
    '',
    '```json',
    '{ "publishedAt": "2026-01-01", "document": {',
    '  "version": 2, "title": "Required title", "description": "", "authorName": "", "markdown": "",',
    '  "blocks": [], "seo": { "title": "", "description": "", "noIndex": false } } }',
    '```',
    '',
    `- \`title\` is required (200 characters); \`description\` 500; \`authorName\` 120; \`markdown\` ${L.documentMarkdown}.`,
    `- At most ${L.blocksV2} blocks; the serialized document must stay under ${L.documentBytes} bytes.`,
    '- `seo.title` (200) and `seo.description` (500) override the page title and description; `seo.noIndex` hides the page from search engines.',
    '- Unknown fields are rejected everywhere. There is no HTML, script, style or component field.',
    '',
    '## Fields every block has',
    '',
    `- \`id\`: required, unique in the document, lowercase \`[a-z][a-z0-9_-]*\`, up to ${L.blockId} characters.`,
    `- \`type\`: one of ${contract.types.map((type) => `\`${type}\``).join(', ')}.`,
    '- `enabled`: optional, default `true`. `false` keeps the block in the draft but removes it from the public page.',
    `- \`heading\`: up to ${L.heading} characters; required except for ${contract.optionalHeading.map((type) => `\`${type}\``).join(', ')}.`,
    '',
    '## Links and images',
    '',
    `- Links (\`href\`, \`src\`, \`poster\`): \`https://\`/\`http://\` URLs, site paths such as \`/pricing\`, or \`#fragment\`; at most ${L.href} characters. No \`javascript:\`, \`data:\`, \`//host\`, spaces, backslashes or user:password.`,
    `- Images are \`{ "src", "alt", "width"?, "height"? }\`; \`alt\` up to ${L.imageAlt} characters (empty only for decorative images); dimensions 1 to ${L.imageDimension}.`,
    '- Upload images in the admin block editor (public assets) and use the returned URL, or put the file in `apps/web/public/` (create the folder) and use `/name.png`.',
    '',
    '## Block types',
    '',
  ];
  for (const type of contract.types) {
    const description = DESCRIPTIONS[type];
    const fields = contract.fields[type];
    const extra = Object.keys(description.fields).filter((field) => !fields.includes(field));
    const undocumented = fields.filter((field) => !Object.hasOwn(description.fields, field));
    if (extra.length || undocumented.length) {
      throw new Error(`Block ${type} fields changed: undescribed ${undocumented.join(', ') || '-'}; removed ${extra.join(', ') || '-'}.`);
    }
    lines.push(`### \`${type}\`${contract.v1.includes(type) ? '' : ' (version 2)'}`, '', fill(description.summary), '');
    for (const field of fields) lines.push(`- \`${field}\`: ${fill(description.fields[field])}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function prepareSkillBlockCatalogue(rootDir, { check = false } = {}) {
  const output = renderBlockCatalogue(readFileSync(join(rootDir, CONTENT_SOURCE), 'utf8'));
  const target = join(rootDir, CATALOGUE_PATH);
  if (check) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* reported as stale */ }
    return { stale: current !== output, output };
  }
  writeFileSync(target, output);
  return { stale: false, output };
}

if (isMainModule(import.meta.url)) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const check = process.argv.includes('--check');
  const { stale } = prepareSkillBlockCatalogue(rootDir, { check });
  if (stale) {
    process.stderr.write(`${CATALOGUE_PATH} is out of date; run node scripts/prepare-skill-block-catalogue.mjs\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(check ? 'Block catalogue is current\n' : `Wrote ${CATALOGUE_PATH}\n`);
  }
}
