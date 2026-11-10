import {
  SITE_BLOCK_TYPES,
  SITE_CONTENT_LIMITS as L,
  SITE_FEATURES_VARIANTS,
  SITE_HERO_VARIANTS,
  type SiteBlockType,
} from '@zucker-framework/fe-site/content';

/**
 * Field table for the form-based block editor. It mirrors the fe-site `content` v2 schema
 * (`validateSiteDocument` field allow-lists and limits): one entry per block type, one field spec per
 * authorable property. The editor renders a typed form from it; validation itself always runs through
 * `validateSiteDocument`, so this table only decides which inputs exist, never what is accepted.
 *
 * Keep in sync with `packages/fe-site/src/content.ts` when a block type or field is added.
 */
export type Label = readonly [zh: string, en: string];

interface FieldBase {
  key: string;
  label: Label;
  hint?: Label;
}
export type FieldSpec =
  /** Plain text; `rows` renders a textarea. Stored as a string ('' when empty, or removed when `optional`). */
  | (FieldBase & {
      kind: 'text';
      max: number;
      required?: boolean;
      rows?: number;
      optional?: boolean;
    })
  /** One of fixed values; `optional` adds a "default" choice that removes the key. */
  | (FieldBase & {
      kind: 'select';
      options: readonly { value: string; label: Label }[];
      optional?: boolean;
    })
  | (FieldBase & { kind: 'boolean' })
  /** Integer; an empty input removes the key (the schema then applies its default or omits it). */
  | (FieldBase & { kind: 'integer'; min: number; max: number })
  /** Link or media URL checked by `safeSiteHref`; optional links are removed when empty. */
  | (FieldBase & { kind: 'href'; required?: boolean })
  /** `{ src, alt, width?, height? }`; optional images are toggled on/off. */
  | (FieldBase & { kind: 'image'; required?: boolean })
  /** `{ label, href }` button; optional actions are toggled on/off. */
  | (FieldBase & { kind: 'action'; required?: boolean })
  /** Repeated items, each a small form. */
  | (FieldBase & {
      kind: 'list';
      max: number;
      item: Label;
      fields: readonly FieldSpec[];
      create: () => Record<string, unknown>;
    })
  /** `'all'` or a list of plan slugs (never prices). */
  | (FieldBase & { kind: 'plans' });

export interface BlockSpec {
  type: SiteBlockType;
  label: Label;
  description: Label;
  /** Type-specific fields in display order (`id`, `enabled` are edited by the block card itself). */
  fields: readonly FieldSpec[];
  /** Initial values for a new block of this type (the id is assigned by the editor). */
  create: () => Record<string, unknown>;
}

const heading = (required = true): FieldSpec => ({
  kind: 'text',
  key: 'heading',
  label: ['标题', 'Heading'],
  max: L.heading,
  required,
});
const body = (rows = 3): FieldSpec => ({
  kind: 'text',
  key: 'text',
  label: ['正文', 'Text'],
  max: L.text,
  rows,
});
const titleText: readonly FieldSpec[] = [
  { kind: 'text', key: 'title', label: ['标题', 'Title'], max: 160, required: true },
  { kind: 'text', key: 'text', label: ['说明', 'Text'], max: L.text, required: true, rows: 2 },
];
const variantOptions = (values: readonly string[], labels: Record<string, Label>) =>
  values.map((value) => ({ value, label: labels[value] ?? [value, value] }));

export const BLOCK_SPECS: Readonly<Record<SiteBlockType, BlockSpec>> = {
  hero: {
    type: 'hero',
    label: ['首屏', 'Hero'],
    description: [
      '页面顶部的大标题、说明和按钮',
      'Large heading, text and buttons at the top of a page',
    ],
    fields: [
      heading(),
      body(),
      { kind: 'action', key: 'action', label: ['主按钮', 'Primary button'] },
      { kind: 'action', key: 'secondaryAction', label: ['次按钮', 'Secondary button'] },
      {
        kind: 'select',
        key: 'variant',
        label: ['布局', 'Layout'],
        optional: true,
        options: variantOptions(SITE_HERO_VARIANTS, {
          centered: ['居中', 'Centered'],
          split: ['左右分栏', 'Split'],
        }),
      },
      { kind: 'image', key: 'image', label: ['配图', 'Image'] },
    ],
    create: () => ({ heading: '', text: '' }),
  },
  markdown: {
    type: 'markdown',
    label: ['Markdown 正文', 'Markdown'],
    description: ['一段 Markdown 文本（不执行 HTML）', 'A Markdown section (HTML is not executed)'],
    fields: [
      heading(false),
      {
        kind: 'text',
        key: 'markdown',
        label: ['Markdown', 'Markdown'],
        max: L.blockMarkdown,
        required: true,
        rows: 8,
      },
    ],
    create: () => ({ heading: '', markdown: '' }),
  },
  features: {
    type: 'features',
    label: ['功能列表', 'Features'],
    description: ['若干功能卡片', 'A set of feature cards'],
    fields: [
      heading(),
      {
        kind: 'select',
        key: 'variant',
        label: ['布局', 'Layout'],
        optional: true,
        options: variantOptions(SITE_FEATURES_VARIANTS, {
          grid: ['网格', 'Grid'],
          list: ['列表', 'List'],
        }),
      },
      { kind: 'image', key: 'image', label: ['配图', 'Image'] },
      {
        kind: 'list',
        key: 'items',
        label: ['功能', 'Features'],
        item: ['功能', 'Feature'],
        max: L.featureItems,
        fields: titleText,
        create: () => ({ title: '', text: '' }),
      },
    ],
    create: () => ({ heading: '', items: [{ title: '', text: '' }] }),
  },
  faq: {
    type: 'faq',
    label: ['常见问题', 'FAQ'],
    description: ['问答列表', 'Questions and answers'],
    fields: [
      heading(),
      {
        kind: 'list',
        key: 'items',
        label: ['问答', 'Questions'],
        item: ['问题', 'Question'],
        max: L.faqItems,
        fields: [
          { kind: 'text', key: 'question', label: ['问题', 'Question'], max: 300, required: true },
          {
            kind: 'text',
            key: 'answer',
            label: ['回答', 'Answer'],
            max: L.text,
            required: true,
            rows: 3,
          },
        ],
        create: () => ({ question: '', answer: '' }),
      },
    ],
    create: () => ({ heading: '', items: [{ question: '', answer: '' }] }),
  },
  cta: {
    type: 'cta',
    label: ['行动号召', 'Call to action'],
    description: ['标题、说明和一个按钮', 'Heading, text and one button'],
    fields: [
      heading(),
      body(),
      { kind: 'action', key: 'action', label: ['按钮', 'Button'], required: true },
    ],
    create: () => ({ heading: '', text: '', action: { label: '', href: '' } }),
  },
  links: {
    type: 'links',
    label: ['链接列表', 'Links'],
    description: ['一组链接', 'A list of links'],
    fields: [
      heading(),
      {
        kind: 'list',
        key: 'items',
        label: ['链接', 'Links'],
        item: ['链接', 'Link'],
        max: L.linkItems,
        fields: [
          { kind: 'text', key: 'label', label: ['名称', 'Label'], max: L.label, required: true },
          { kind: 'href', key: 'href', label: ['地址', 'URL'], required: true },
        ],
        create: () => ({ label: '', href: '' }),
      },
    ],
    create: () => ({ heading: '', items: [{ label: '', href: '' }] }),
  },
  'logo-cloud': {
    type: 'logo-cloud',
    label: ['客户 Logo', 'Logo cloud'],
    description: ['合作方或客户的 Logo 墙', 'Partner or customer logos'],
    fields: [
      heading(false),
      {
        kind: 'list',
        key: 'items',
        label: ['Logo', 'Logos'],
        item: ['Logo', 'Logo'],
        max: L.logoItems,
        fields: [
          { kind: 'text', key: 'name', label: ['名称', 'Name'], max: 120, required: true },
          { kind: 'image', key: 'image', label: ['图片', 'Image'], required: true },
          { kind: 'href', key: 'href', label: ['链接', 'Link'] },
        ],
        create: () => ({ name: '', image: { src: '', alt: '' } }),
      },
    ],
    create: () => ({ heading: '', items: [{ name: '', image: { src: '', alt: '' } }] }),
  },
  stats: {
    type: 'stats',
    label: ['数据指标', 'Stats'],
    description: ['几项展示用数字', 'A few display figures'],
    fields: [
      heading(),
      body(2),
      {
        kind: 'list',
        key: 'items',
        label: ['指标', 'Figures'],
        item: ['指标', 'Figure'],
        max: L.statItems,
        hint: [
          '数值是展示文本，例如 “99.9%” 或 “10k+”。',
          'Values are display text such as "99.9%" or "10k+".',
        ],
        fields: [
          { kind: 'text', key: 'value', label: ['数值', 'Value'], max: 32, required: true },
          { kind: 'text', key: 'label', label: ['说明', 'Label'], max: 120, required: true },
        ],
        create: () => ({ value: '', label: '' }),
      },
    ],
    create: () => ({ heading: '', text: '', items: [{ value: '', label: '' }] }),
  },
  steps: {
    type: 'steps',
    label: ['使用步骤', 'Steps'],
    description: ['按顺序的步骤', 'Numbered steps'],
    fields: [
      heading(),
      body(2),
      {
        kind: 'list',
        key: 'items',
        label: ['步骤', 'Steps'],
        item: ['步骤', 'Step'],
        max: L.stepItems,
        fields: titleText,
        create: () => ({ title: '', text: '' }),
      },
    ],
    create: () => ({ heading: '', text: '', items: [{ title: '', text: '' }] }),
  },
  testimonials: {
    type: 'testimonials',
    label: ['用户评价', 'Testimonials'],
    description: ['用户引用', 'Customer quotes'],
    fields: [
      heading(),
      {
        kind: 'list',
        key: 'items',
        label: ['评价', 'Quotes'],
        item: ['评价', 'Quote'],
        max: L.testimonialItems,
        fields: [
          {
            kind: 'text',
            key: 'quote',
            label: ['评价内容', 'Quote'],
            max: 1200,
            required: true,
            rows: 3,
          },
          { kind: 'text', key: 'author', label: ['姓名', 'Author'], max: 120, required: true },
          { kind: 'text', key: 'role', label: ['身份', 'Role'], max: 160 },
          { kind: 'image', key: 'avatar', label: ['头像', 'Avatar'] },
        ],
        create: () => ({ quote: '', author: '', role: '' }),
      },
    ],
    create: () => ({ heading: '', items: [{ quote: '', author: '', role: '' }] }),
  },
  showcase: {
    type: 'showcase',
    label: ['案例展示', 'Showcase'],
    description: ['带图片的作品或案例', 'Work or cases with images'],
    fields: [
      heading(),
      body(2),
      {
        kind: 'list',
        key: 'items',
        label: ['案例', 'Items'],
        item: ['案例', 'Item'],
        max: L.showcaseItems,
        fields: [
          { kind: 'text', key: 'title', label: ['标题', 'Title'], max: 160, required: true },
          { kind: 'text', key: 'text', label: ['说明', 'Text'], max: 1000, rows: 2 },
          { kind: 'image', key: 'image', label: ['封面图', 'Cover image'], required: true },
          { kind: 'href', key: 'href', label: ['链接', 'Link'] },
        ],
        create: () => ({ title: '', text: '', image: { src: '', alt: '' } }),
      },
    ],
    create: () => ({
      heading: '',
      text: '',
      items: [{ title: '', text: '', image: { src: '', alt: '' } }],
    }),
  },
  pricing: {
    type: 'pricing',
    label: ['价格', 'Pricing'],
    description: [
      '从套餐目录读取的价格卡片（不在此填写价格）',
      'Plan cards from the billing catalog (prices are not entered here)',
    ],
    fields: [
      heading(),
      body(2),
      { kind: 'plans', key: 'plans', label: ['套餐', 'Plans'] },
      {
        kind: 'boolean',
        key: 'showCreditPacks',
        label: ['同时显示积分包', 'Also show credit packs'],
      },
    ],
    create: () => ({ heading: '', text: '', plans: 'all', showCreditPacks: false }),
  },
  newsletter: {
    type: 'newsletter',
    label: ['邮件订阅', 'Newsletter'],
    description: ['只有邮箱一个字段的订阅表单', 'A sign-up form with one email field'],
    fields: [
      heading(),
      body(2),
      {
        kind: 'text',
        key: 'formAction',
        label: ['提交地址', 'Form action'],
        max: L.href,
        required: true,
        hint: [
          'https 地址或站内路径（例如 /api/newsletter）。',
          'An https URL or a same-site path such as /api/newsletter.',
        ],
      },
      {
        kind: 'text',
        key: 'emailLabel',
        label: ['邮箱输入框名称', 'Email field label'],
        max: L.label,
        required: true,
      },
      {
        kind: 'text',
        key: 'buttonLabel',
        label: ['按钮文字', 'Button label'],
        max: L.label,
        required: true,
      },
    ],
    create: () => ({ heading: '', text: '', formAction: '', emailLabel: '', buttonLabel: '' }),
  },
  'blog-list': {
    type: 'blog-list',
    label: ['最新文章', 'Blog list'],
    description: ['自动列出最新博客文章', 'Lists the latest blog posts automatically'],
    fields: [
      heading(),
      body(2),
      {
        kind: 'integer',
        key: 'limit',
        label: ['数量', 'Count'],
        min: 1,
        max: L.blogListLimit,
        hint: ['留空为 3。', 'Empty means 3.'],
      },
      {
        kind: 'text',
        key: 'category',
        label: ['分类标识', 'Category slug'],
        max: L.slug,
        optional: true,
        hint: ['留空显示全部分类。', 'Empty shows every category.'],
      },
    ],
    create: () => ({ heading: '', text: '', limit: 3 }),
  },
  changelog: {
    type: 'changelog',
    label: ['更新日志', 'Changelog'],
    description: ['自动列出最新的更新日志', 'Lists the latest changelog entries automatically'],
    fields: [
      heading(),
      body(2),
      {
        kind: 'integer',
        key: 'limit',
        label: ['数量', 'Count'],
        min: 1,
        max: L.changelogLimit,
        hint: ['留空为 5。', 'Empty means 5.'],
      },
    ],
    create: () => ({ heading: '', text: '', limit: 5 }),
  },
  media: {
    type: 'media',
    label: ['图片或视频', 'Image or video'],
    description: ['一张图片或一段视频', 'One image or video'],
    fields: [
      heading(false),
      {
        kind: 'select',
        key: 'kind',
        label: ['类型', 'Type'],
        options: [
          { value: 'image', label: ['图片', 'Image'] },
          { value: 'video', label: ['视频', 'Video'] },
        ],
      },
      { kind: 'href', key: 'src', label: ['文件地址', 'File URL'], required: true },
      {
        kind: 'text',
        key: 'alt',
        label: ['替代文本', 'Alternative text'],
        max: L.imageAlt,
        required: true,
        hint: [
          '供读屏软件使用；视频的可访问名称。',
          'Read by screen readers; the accessible name of a video.',
        ],
      },
      { kind: 'text', key: 'caption', label: ['图注', 'Caption'], max: 500 },
      { kind: 'href', key: 'poster', label: ['视频封面图', 'Video poster image'] },
      {
        kind: 'integer',
        key: 'width',
        label: ['宽度（像素）', 'Width (px)'],
        min: 1,
        max: L.imageDimension,
      },
      {
        kind: 'integer',
        key: 'height',
        label: ['高度（像素）', 'Height (px)'],
        min: 1,
        max: L.imageDimension,
      },
    ],
    create: () => ({ heading: '', kind: 'image', src: '', alt: '', caption: '' }),
  },
};

/** Block types in the order the "add block" menu offers them. */
export const BLOCK_TYPE_ORDER: readonly SiteBlockType[] = SITE_BLOCK_TYPES;

/** Fields of an image object (`kind: 'image'`). */
export const IMAGE_FIELDS: readonly FieldSpec[] = [
  { kind: 'href', key: 'src', label: ['图片地址', 'Image URL'], required: true },
  {
    kind: 'text',
    key: 'alt',
    label: ['替代文本', 'Alternative text'],
    max: L.imageAlt,
    hint: ['留空表示装饰性图片。', 'Leave empty for a decorative image.'],
  },
  {
    kind: 'integer',
    key: 'width',
    label: ['宽度（像素）', 'Width (px)'],
    min: 1,
    max: L.imageDimension,
  },
  {
    kind: 'integer',
    key: 'height',
    label: ['高度（像素）', 'Height (px)'],
    min: 1,
    max: L.imageDimension,
  },
];
/** Fields of a button object (`kind: 'action'`). */
export const ACTION_FIELDS: readonly FieldSpec[] = [
  { kind: 'text', key: 'label', label: ['按钮文字', 'Label'], max: L.label, required: true },
  { kind: 'href', key: 'href', label: ['链接地址', 'URL'], required: true },
];
