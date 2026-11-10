import { Button, Field, Notice, Textarea } from '@zucker-framework/fe-admin';
import { BlockRenderer, type BlockSlots } from '@zucker-framework/fe-blocks';
import type { ValidatedSiteDocument } from '@zucker-framework/fe-site/content';
import { useState } from 'react';
import { useText } from '../../text';
import {
  checkDocument,
  isEditableBlockList,
  type BlockDraft,
  type DocumentCheck,
  type DocumentDraft,
} from './block-document';
import { issueSummary } from './block-editor';

type Tx = (zh: string, en: string) => string;

function Placeholder({ children }: { children: string }) {
  return (
    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Preview slots. The admin has no site data, so data-backed blocks show what they will load, the
 * markdown slot shows the source as plain text (the site renders it with HTML disabled), and the
 * newsletter form cannot submit.
 */
function previewSlots(tx: Tx): BlockSlots {
  return {
    markdown: ({ markdown }) => (
      <div className="whitespace-pre-wrap text-sm leading-6">{markdown}</div>
    ),
    pricing: ({ plans, showCreditPacks }) => (
      <Placeholder>
        {tx(
          `价格卡片：${plans === 'all' ? '全部公开套餐' : plans.join('、')}${showCreditPacks ? '，以及积分包' : ''}（价格来自套餐目录）`,
          `Pricing cards: ${plans === 'all' ? 'all public plans' : plans.join(', ')}${showCreditPacks ? ', plus credit packs' : ''} (prices come from the plan catalog)`,
        )}
      </Placeholder>
    ),
    blogList: ({ limit, category }) => (
      <Placeholder>
        {tx(
          `最新 ${limit} 篇博客文章${category ? `（分类 ${category}）` : ''}`,
          `Latest ${limit} blog posts${category ? ` (category ${category})` : ''}`,
        )}
      </Placeholder>
    ),
    changelog: ({ limit }) => (
      <Placeholder>
        {tx(`最新 ${limit} 条更新日志`, `Latest ${limit} changelog entries`)}
      </Placeholder>
    ),
    newsletter: ({ block }) => (
      <div className="flex max-w-md flex-wrap gap-2" aria-disabled="true">
        <input
          type="email"
          disabled
          aria-label={block.emailLabel}
          placeholder={block.emailLabel}
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <button type="button" disabled className="rounded-md border px-3 py-2 text-sm">
          {block.buttonLabel}
        </button>
      </div>
    ),
  };
}

/** Renders a validated document with the same safe renderer as the public site (default theme). */
export function DocumentPreview({
  document,
  locale,
}: {
  document: ValidatedSiteDocument;
  locale: string;
}) {
  const tx = useText();
  const visible = document.blocks.filter((block) => block.enabled);
  return (
    <div
      className="max-h-[70vh] overflow-auto rounded-lg border bg-background p-6 text-foreground"
      // Links and forms inside the preview must not navigate away from the editor.
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest('a')) event.preventDefault();
      }}
      onSubmitCapture={(event) => event.preventDefault()}
    >
      {document.title && (
        <h1 className="mb-6 text-3xl font-semibold tracking-tight">{document.title}</h1>
      )}
      {!visible.length && !document.markdown.trim() ? (
        <p className="text-sm text-muted-foreground">
          {tx(
            '没有可显示的内容（隐藏的内容块不会公开）。',
            'Nothing to show (hidden blocks are never public).',
          )}
        </p>
      ) : (
        <BlockRenderer document={document} locale={locale} slots={previewSlots(tx)} />
      )}
    </div>
  );
}

/** Preview tab: validates the current draft first and shows the field path when it fails. */
export function DraftPreview({ draft, locale }: { draft: DocumentDraft; locale: string }) {
  const tx = useText();
  const check: DocumentCheck = checkDocument(draft);
  if (!check.ok)
    return (
      <Notice tone="warning" title={tx('修正以下问题后才能预览', 'Fix this before previewing')}>
        {issueSummary(check.issue, draft.blocks, tx)}
      </Notice>
    );
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {tx(
          '预览使用默认主题；价格、文章和更新日志在公开站点按实际数据显示。',
          'The preview uses the default theme; pricing, posts and changelog show live data on the public site.',
        )}
      </p>
      <DocumentPreview document={check.document} locale={locale} />
    </div>
  );
}

/**
 * Advanced view: the blocks as JSON. Applying replaces the form state only when the JSON is an array
 * of supported block objects; the full schema check then runs like any other edit.
 */
export function BlocksJsonEditor({
  draft,
  onApply,
  disabled = false,
}: {
  draft: DocumentDraft;
  onApply: (blocks: BlockDraft[]) => void;
  disabled?: boolean;
}) {
  const tx = useText();
  const [text, setText] = useState(() => JSON.stringify(draft.blocks, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  function apply() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setProblem(tx('JSON 格式无效', 'The JSON is not valid'));
      return;
    }
    if (!isEditableBlockList(parsed)) {
      setProblem(
        tx(
          '必须是内容块数组，且每个内容块的 type 都是支持的类型',
          'Expected an array of blocks, each with a supported type',
        ),
      );
      return;
    }
    const check = checkDocument({ ...draft, blocks: parsed });
    setProblem(check.ok ? null : issueSummary(check.issue, parsed, tx));
    onApply(parsed);
  }
  return (
    <div className="space-y-3">
      <Notice tone="info" title={tx('高级：直接编辑 JSON', 'Advanced: edit the JSON')}>
        {tx(
          '应用后表单会同步更新；保存前仍会完整校验。',
          'Applying updates the forms; the full check still runs before saving.',
        )}
      </Notice>
      {problem && <Notice tone="danger" title={problem} />}
      <Field label={tx('内容块（JSON 数组）', 'Blocks (JSON array)')}>
        {({ id }) => (
          <Textarea
            id={id}
            rows={18}
            spellCheck={false}
            className="font-mono text-xs"
            disabled={disabled}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>
      <Button disabled={disabled} onClick={apply}>
        {tx('应用 JSON', 'Apply JSON')}
      </Button>
    </div>
  );
}
