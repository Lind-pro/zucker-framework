import {
  Button,
  Field,
  Input,
  Notice,
  Select,
  StatusBadge,
  Switch,
  Textarea,
  cn,
} from '@zucker-framework/fe-admin';
import {
  SITE_CONTENT_LIMITS,
  safeSiteHref,
  type SiteBlockType,
} from '@zucker-framework/fe-site/content';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useText } from '../../text';
import { PublicAssetUploadButton } from '../public-assets/upload-button';
import {
  ACTION_FIELDS,
  BLOCK_SPECS,
  BLOCK_TYPE_ORDER,
  IMAGE_FIELDS,
  type FieldSpec,
  type Label,
} from './block-fields';
import {
  createBlock,
  describeField,
  moveBlock,
  type BlockDraft,
  type DocumentIssue,
} from './block-document';

type Tx = (zh: string, en: string) => string;
interface EditorContextValue {
  tx: Tx;
  disabled: boolean;
  issue: DocumentIssue | null;
}
const EditorContext = createContext<EditorContextValue>({
  tx: (_zh, en) => en,
  disabled: false,
  issue: null,
});

/** Validator messages are English; show the common ones in the admin language. */
const ISSUE_TEXT: Record<string, Label> = {
  'Text is required': ['必填', 'Required'],
  'Invalid text or length': ['文本无效或超出长度', 'Invalid text or too long'],
  'Expected a safe web link': [
    '请填写 http(s) 地址或站内路径',
    'Enter an http(s) URL or a site path',
  ],
  'Expected a lowercase block identifier': [
    '以小写字母开头，只含小写字母、数字、- 和 _',
    'Start with a lowercase letter; use lowercase letters, digits, - and _',
  ],
  'Block identifiers must be unique': ['锚点 ID 不能重复', 'Anchor IDs must be unique'],
  'Expected a lowercase slug': [
    '请使用小写字母、数字、- 或 _',
    'Use lowercase letters, digits, - or _',
  ],
  'Expected an https URL or a same-origin path': [
    '请填写 https 地址或以 / 开头的站内路径',
    'Enter an https URL or a path starting with /',
  ],
  'Select at least one plan or "all"': [
    '至少选择一个套餐，或选择全部',
    'Select at least one plan or all plans',
  ],
  'Plan slugs must be unique': ['套餐标识不能重复', 'Plan slugs must be unique'],
  'Invalid list': ['条目数量超出上限', 'Too many entries'],
  'Document exceeds 64 KiB': ['文档超过 64 KiB', 'The document exceeds 64 KiB'],
};
export function issueText(message: string, tx: Tx): string {
  const known = ISSUE_TEXT[message];
  if (known) return tx(known[0], known[1]);
  const range = /^Expected an integer from (\d+) to (\d+)$/.exec(message);
  if (range)
    return tx(
      `请输入 ${range[1]} 到 ${range[2]} 的整数`,
      `Enter a whole number from ${range[1]} to ${range[2]}`,
    );
  return message;
}

/** Full, localized description of a validation issue: "Block 2 · Hero › Heading: Required". */
export function issueSummary(
  issue: DocumentIssue,
  blocks: readonly { type?: unknown }[],
  tx: Tx,
): string {
  return `${describeField(issue.field, blocks, tx)}: ${issueText(issue.message, tx)}`;
}

function useEditor() {
  return useContext(EditorContext);
}
function errorAt(issue: DocumentIssue | null, path: string, tx: Tx): string | undefined {
  return issue?.field === path ? issueText(issue.message, tx) : undefined;
}
function withKey(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...record };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asText = (value: unknown) =>
  typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);

/** Small preview of an image URL that passes the same `safeSiteHref` check the site applies. */
function ImageThumbnail({ src }: { src: unknown }) {
  const safe = typeof src === 'string' ? safeSiteHref(src) : null;
  if (!safe) return null;
  return (
    <img
      src={safe}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="h-20 max-w-48 rounded-md border bg-muted object-contain"
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
    />
  );
}

function PlansInput({
  value,
  path,
  onChange,
  label,
}: {
  value: unknown;
  path: string;
  onChange: (value: unknown) => void;
  label: string;
}) {
  const { tx, disabled, issue } = useEditor();
  const all = value === 'all';
  // Keep the typed text (including a trailing comma) while the stored value is the parsed list.
  const [text, setText] = useState(Array.isArray(value) ? value.join(', ') : '');
  const error =
    errorAt(issue, path, tx) ??
    (issue?.field.startsWith(`${path}.`) ? issueText(issue.message, tx) : undefined);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={label} required>
        {({ id }) => (
          <Select
            id={id}
            disabled={disabled}
            value={all ? 'all' : 'selected'}
            onChange={(event) =>
              onChange(
                event.target.value === 'all'
                  ? 'all'
                  : text
                      .split(',')
                      .map((entry) => entry.trim())
                      .filter(Boolean),
              )
            }
            options={[
              { value: 'all', label: tx('全部公开套餐', 'All public plans') },
              { value: 'selected', label: tx('指定套餐', 'Selected plans') },
            ]}
          />
        )}
      </Field>
      {!all && (
        <Field
          label={tx('套餐标识（逗号分隔）', 'Plan slugs (comma separated)')}
          required
          error={error}
          description={tx(
            `按顺序显示，最多 ${SITE_CONTENT_LIMITS.pricingPlans} 个；价格来自套餐目录。`,
            `Shown in this order, at most ${SITE_CONTENT_LIMITS.pricingPlans}; prices come from the plan catalog.`,
          )}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              data-field={path}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              placeholder="basic, pro"
              disabled={disabled}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                onChange(
                  event.target.value
                    .split(',')
                    .map((entry) => entry.trim())
                    .filter(Boolean),
                );
              }}
            />
          )}
        </Field>
      )}
    </div>
  );
}

/** One object-valued field (image or button) that may be optional. */
function ObjectField({
  spec,
  value,
  path,
  onChange,
  fields,
}: {
  spec: FieldSpec;
  value: unknown;
  path: string;
  onChange: (value: unknown) => void;
  fields: readonly FieldSpec[];
}) {
  const { tx, disabled, issue } = useEditor();
  const required = 'required' in spec && spec.required === true;
  const label = tx(spec.label[0], spec.label[1]);
  const present = value !== undefined;
  const record = asRecord(value);
  if (!present && !required)
    return (
      <div>
        <Button
          size="sm"
          icon={<Plus />}
          disabled={disabled}
          onClick={() =>
            onChange(spec.kind === 'image' ? { src: '', alt: '' } : { label: '', href: '' })
          }
        >
          {tx(`添加${label}`, `Add ${label.toLowerCase()}`)}
        </Button>
      </div>
    );
  const containerError = errorAt(issue, path, tx);
  return (
    <fieldset
      className="space-y-3 rounded-lg border p-3"
      data-field={containerError ? path : undefined}
      tabIndex={containerError ? -1 : undefined}
    >
      <legend className="px-1 text-sm font-medium">
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </legend>
      {containerError && (
        <p role="alert" className="text-xs text-destructive">
          {containerError}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <FieldControl
            key={field.key}
            spec={field}
            value={record[field.key]}
            path={`${path}.${field.key}`}
            onChange={(next) => onChange(withKey(record, field.key, next))}
          />
        ))}
      </div>
      {spec.kind === 'image' && <ImageThumbnail src={record.src} />}
      {!required && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          icon={<Trash2 />}
          disabled={disabled}
          onClick={() => onChange(undefined)}
        >
          {tx(`移除${label}`, `Remove ${label.toLowerCase()}`)}
        </Button>
      )}
    </fieldset>
  );
}

function ListField({
  spec,
  value,
  path,
  onChange,
}: {
  spec: Extract<FieldSpec, { kind: 'list' }>;
  value: unknown;
  path: string;
  onChange: (value: unknown) => void;
}) {
  const { tx, disabled, issue } = useEditor();
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const itemLabel = tx(spec.item[0], spec.item[1]);
  const containerError = errorAt(issue, path, tx);
  return (
    <fieldset
      className="space-y-3"
      data-field={containerError ? path : undefined}
      tabIndex={containerError ? -1 : undefined}
    >
      <legend className="text-sm font-medium">
        {tx(spec.label[0], spec.label[1])}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {items.length}/{spec.max}
        </span>
      </legend>
      {spec.hint && (
        <p className="text-xs text-muted-foreground">{tx(spec.hint[0], spec.hint[1])}</p>
      )}
      {containerError && (
        <p role="alert" className="text-xs text-destructive">
          {containerError}
        </p>
      )}
      <ol className="space-y-3">
        {items.map((item, index) => {
          const record = asRecord(item);
          const at = `${path}.${index}`;
          const name = `${itemLabel} ${index + 1}`;
          return (
            // Items have no identity of their own; position is the identity while editing.
            <li key={index} className="space-y-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{name}</span>
                <span className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tx(`上移${name}`, `Move ${name} up`)}
                    disabled={disabled || index === 0}
                    onClick={() => onChange(moveBlock(items, index, index - 1))}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tx(`下移${name}`, `Move ${name} down`)}
                    disabled={disabled || index === items.length - 1}
                    onClick={() => onChange(moveBlock(items, index, index + 1))}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tx(`删除${name}`, `Delete ${name}`)}
                    disabled={disabled}
                    onClick={() => onChange(items.filter((_, position) => position !== index))}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {spec.fields.map((field) => (
                  <FieldControl
                    key={field.key}
                    spec={field}
                    value={record[field.key]}
                    path={`${at}.${field.key}`}
                    onChange={(next) =>
                      onChange(
                        items.map((entry, position) =>
                          position === index ? withKey(record, field.key, next) : entry,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        size="sm"
        icon={<Plus />}
        disabled={disabled || items.length >= spec.max}
        onClick={() => onChange([...items, spec.create()])}
      >
        {tx(`添加${itemLabel}`, `Add ${itemLabel.toLowerCase()}`)}
      </Button>
    </fieldset>
  );
}

/** Renders one field of the table as a typed input. `onChange(undefined)` removes the key. */
export function FieldControl({
  spec,
  value,
  path,
  onChange,
}: {
  spec: FieldSpec;
  value: unknown;
  path: string;
  onChange: (value: unknown) => void;
}) {
  const { tx, disabled, issue } = useEditor();
  const label = tx(spec.label[0], spec.label[1]);
  const hint = spec.hint ? tx(spec.hint[0], spec.hint[1]) : undefined;
  const error = errorAt(issue, path, tx);
  const common = (describedBy: string | undefined, invalid: boolean) => ({
    'data-field': path,
    'aria-describedby': describedBy,
    'aria-invalid': invalid || undefined,
    disabled,
  });
  switch (spec.kind) {
    case 'text':
      return (
        <Field
          label={label}
          required={spec.required}
          description={hint}
          error={error}
          className={spec.rows ? 'sm:col-span-2' : undefined}
        >
          {({ id, describedBy, invalid }) =>
            spec.rows ? (
              <Textarea
                id={id}
                rows={spec.rows}
                maxLength={spec.max}
                {...common(describedBy, invalid)}
                value={asText(value)}
                onChange={(event) =>
                  onChange(spec.optional && !event.target.value ? undefined : event.target.value)
                }
              />
            ) : (
              <Input
                id={id}
                maxLength={spec.max}
                {...common(describedBy, invalid)}
                value={asText(value)}
                onChange={(event) =>
                  onChange(spec.optional && !event.target.value ? undefined : event.target.value)
                }
              />
            )
          }
        </Field>
      );
    case 'href':
      return (
        <Field
          label={label}
          required={spec.required}
          description={
            hint ??
            tx(
              'http(s) 地址或站内路径，例如 /pricing',
              'An http(s) URL or a site path such as /pricing',
            )
          }
          error={error}
        >
          {({ id, describedBy, invalid }) => {
            const input = (
              <Input
                id={id}
                maxLength={SITE_CONTENT_LIMITS.href}
                placeholder="/pricing · https://…"
                {...common(describedBy, invalid)}
                value={asText(value)}
                onChange={(event) =>
                  onChange(!spec.required && !event.target.value ? undefined : event.target.value)
                }
              />
            );
            return spec.upload ? (
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-48 flex-1">{input}</div>
                <PublicAssetUploadButton disabled={disabled} onUploaded={(url) => onChange(url)} />
              </div>
            ) : (
              input
            );
          }}
        </Field>
      );
    case 'integer':
      return (
        <Field label={label} description={hint} error={error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="numeric"
              {...common(describedBy, invalid)}
              value={asText(value)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                // Non-numeric text is kept so the validator reports it at this field.
                onChange(raw === '' ? undefined : /^\d{1,9}$/.test(raw) ? Number(raw) : raw);
              }}
            />
          )}
        </Field>
      );
    case 'select':
      return (
        <Field label={label} description={hint} error={error}>
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              {...common(describedBy, invalid)}
              value={asText(value)}
              onChange={(event) =>
                onChange(spec.optional && !event.target.value ? undefined : event.target.value)
              }
              options={[
                ...(spec.optional ? [{ value: '', label: tx('默认', 'Default') }] : []),
                ...spec.options.map((option) => ({
                  value: option.value,
                  label: tx(option.label[0], option.label[1]),
                })),
              ]}
            />
          )}
        </Field>
      );
    case 'boolean':
      return (
        <Field label={label} description={hint} error={error} inline>
          {({ id }) => (
            <Switch
              id={id}
              data-field={path}
              checked={value === true}
              disabled={disabled}
              onCheckedChange={(checked) => onChange(checked)}
            />
          )}
        </Field>
      );
    case 'image':
      return (
        <div className="sm:col-span-2">
          <ObjectField
            spec={spec}
            value={value}
            path={path}
            onChange={onChange}
            fields={IMAGE_FIELDS}
          />
        </div>
      );
    case 'action':
      return (
        <div className="sm:col-span-2">
          <ObjectField
            spec={spec}
            value={value}
            path={path}
            onChange={onChange}
            fields={ACTION_FIELDS}
          />
        </div>
      );
    case 'list':
      return (
        <div className="sm:col-span-2">
          <ListField spec={spec} value={value} path={path} onChange={onChange} />
        </div>
      );
    case 'plans':
      return (
        <div className="sm:col-span-2">
          <PlansInput value={value} path={path} onChange={onChange} label={label} />
        </div>
      );
  }
}

let keySequence = 0;
const nextKey = () => `block-${++keySequence}`;

/**
 * Form-based editor for a document's blocks: add, reorder, show/hide, remove, and a typed form per
 * block type generated from `BLOCK_SPECS`. It never renders stored content as HTML. `issue` is the
 * last `validateSiteDocument` failure; the matching input shows it and receives focus.
 */
export function BlockListEditor({
  blocks,
  onChange,
  issue,
  disabled = false,
}: {
  blocks: readonly BlockDraft[];
  onChange: (blocks: BlockDraft[]) => void;
  issue: DocumentIssue | null;
  disabled?: boolean;
}) {
  const tx = useText();
  const [addType, setAddType] = useState<SiteBlockType>('hero');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  // Stable React keys that survive reordering and id edits; reset when the list is replaced.
  const keys = useRef<string[]>([]);
  if (keys.current.length !== blocks.length) keys.current = blocks.map(() => nextKey());
  const change = (next: BlockDraft[], nextKeys: string[]) => {
    keys.current = nextKeys;
    onChange(next);
  };
  const update = (index: number, block: BlockDraft) =>
    change(
      blocks.map((entry, position) => (position === index ? block : entry)),
      keys.current,
    );

  const issueBlock = issue && /^blocks\.(\d+)(\.|$)/.exec(issue.field)?.[1];
  useEffect(() => {
    if (issueBlock === null || issueBlock === undefined || !issue) return;
    const key = keys.current[Number(issueBlock)];
    if (key)
      setCollapsed((previous) =>
        previous.has(key) ? new Set([...previous].filter((entry) => entry !== key)) : previous,
      );
    // Focus after the expanded block has rendered.
    const frame = requestAnimationFrame(() => {
      const container = root.current;
      if (!container) return;
      const target =
        container.querySelector<HTMLElement>(`[data-field="${CSS.escape(issue.field)}"]`) ??
        container.querySelector<HTMLElement>(`[data-block-path="blocks.${issueBlock}"]`);
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [issue, issueBlock]);

  const limit = SITE_CONTENT_LIMITS.blocksV2;
  return (
    <EditorContext.Provider value={{ tx, disabled, issue }}>
      <div ref={root} className="space-y-4">
        {issue?.field === 'blocks' && <Notice tone="danger" title={issueText(issue.message, tx)} />}
        {blocks.length === 0 && (
          <p className="text-sm text-muted-foreground">{tx('还没有内容块。', 'No blocks yet.')}</p>
        )}
        <ol className="space-y-3">
          {blocks.map((block, index) => {
            const spec = BLOCK_SPECS[block.type];
            const key = keys.current[index]!;
            const open = !collapsed.has(key);
            const path = `blocks.${index}`;
            const name = `${tx('内容块', 'Block')} ${index + 1}`;
            const typeLabel = spec ? tx(spec.label[0], spec.label[1]) : block.type;
            const hasIssue = issue?.field === path || issue?.field.startsWith(`${path}.`);
            return (
              <li
                key={key}
                data-block-path={path}
                tabIndex={-1}
                className={cn(
                  'rounded-lg border bg-card focus-visible:outline-2 focus-visible:outline-ring',
                  hasIssue && 'border-destructive',
                  !block.enabled && 'opacity-70',
                )}
              >
                <div className="flex flex-wrap items-center gap-2 border-b p-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-expanded={open}
                    aria-label={
                      open
                        ? tx(`收起${name}`, `Collapse ${name}`)
                        : tx(`展开${name}`, `Expand ${name}`)
                    }
                    onClick={() =>
                      setCollapsed((previous) =>
                        open
                          ? new Set([...previous, key])
                          : new Set([...previous].filter((entry) => entry !== key)),
                      )
                    }
                  >
                    {open ? <ChevronDown /> : <ChevronRight />}
                  </Button>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {index + 1}. {typeLabel}
                    <span className="ml-2 font-normal text-muted-foreground">#{block.id}</span>
                  </span>
                  {!block.enabled && (
                    <StatusBadge tone="neutral">{tx('已隐藏', 'Hidden')}</StatusBadge>
                  )}
                  {hasIssue && (
                    <StatusBadge tone="danger">{tx('需修改', 'Needs attention')}</StatusBadge>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      aria-label={tx(`显示${name}`, `Show ${name}`)}
                      checked={block.enabled !== false}
                      disabled={disabled}
                      onCheckedChange={(checked) => update(index, { ...block, enabled: checked })}
                    />
                    {tx('显示', 'Shown')}
                  </label>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tx(`上移${name}`, `Move ${name} up`)}
                    disabled={disabled || index === 0}
                    onClick={() =>
                      change(
                        moveBlock(blocks, index, index - 1),
                        moveBlock(keys.current, index, index - 1),
                      )
                    }
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tx(`下移${name}`, `Move ${name} down`)}
                    disabled={disabled || index === blocks.length - 1}
                    onClick={() =>
                      change(
                        moveBlock(blocks, index, index + 1),
                        moveBlock(keys.current, index, index + 1),
                      )
                    }
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tx(`删除${name}`, `Delete ${name}`)}
                    disabled={disabled}
                    onClick={() =>
                      change(
                        blocks.filter((_, position) => position !== index),
                        keys.current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                {open && (
                  <div className="space-y-3 p-3">
                    {spec && (
                      <p className="text-xs text-muted-foreground">
                        {tx(spec.description[0], spec.description[1])}
                      </p>
                    )}
                    {issue?.field === path && (
                      <p role="alert" className="text-xs text-destructive">
                        {issueText(issue.message, tx)}
                      </p>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <FieldControl
                        spec={{
                          kind: 'text',
                          key: 'id',
                          label: ['锚点 ID', 'Anchor ID'],
                          max: SITE_CONTENT_LIMITS.blockId,
                          required: true,
                          hint: [
                            '页面内链接使用 #ID；小写字母开头。',
                            'Used for #links within the page; starts with a lowercase letter.',
                          ],
                        }}
                        value={block.id}
                        path={`${path}.id`}
                        onChange={(next) => update(index, { ...block, id: asText(next) })}
                      />
                      {spec?.fields.map((field) => (
                        <FieldControl
                          key={field.key}
                          spec={field}
                          value={block[field.key]}
                          path={`${path}.${field.key}`}
                          onChange={(next) =>
                            update(index, withKey(block, field.key, next) as BlockDraft)
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={tx('内容块类型', 'Block type')}>
            {({ id }) => (
              <Select
                id={id}
                disabled={disabled}
                value={addType}
                onChange={(event) => setAddType(event.target.value as SiteBlockType)}
                options={BLOCK_TYPE_ORDER.map((type) => ({
                  value: type,
                  label: tx(BLOCK_SPECS[type].label[0], BLOCK_SPECS[type].label[1]),
                }))}
              />
            )}
          </Field>
          <Button
            icon={<Plus />}
            disabled={disabled || blocks.length >= limit}
            onClick={() =>
              change([...blocks, createBlock(addType, blocks)], [...keys.current, nextKey()])
            }
          >
            {tx('添加内容块', 'Add block')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {blocks.length}/{limit}
          </span>
        </div>
      </div>
    </EditorContext.Provider>
  );
}
