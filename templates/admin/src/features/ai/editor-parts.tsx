import { Button, Input, StatusBadge } from '@zucker-framework/fe-admin';
import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useText } from '../../text';
import type { AIKind } from './policy-layout';
import { MAX_CREDITS, MAX_LABEL, MAX_ROWS, MAX_TOKEN_RATE, type IssueCode } from './validation';

export function useKindLabel() {
  const tx = useText();
  return (kind: AIKind) =>
    ({ image: tx('图片', 'Image'), video: tx('视频', 'Video'), audio: tx('音频', 'Audio'), chat: tx('对话', 'Chat') })[kind];
}

export function useIssueText() {
  const tx = useText();
  return (code: IssueCode | undefined): string | undefined => {
    switch (code) {
      case undefined:
        return undefined;
      case 'required':
        return tx('必填', 'Required');
      case 'integer':
        return tx('请输入非负整数', 'Enter a whole number of 0 or more');
      case 'decimal':
        return tx('请输入非负数，最多 4 位小数', 'Enter a number of 0 or more with at most 4 decimals');
      case 'tooLarge':
        return tx(`数值过大（积分上限 ${MAX_CREDITS}，费率上限 ${MAX_TOKEN_RATE}）`, `Too large (credits up to ${MAX_CREDITS}, rates up to ${MAX_TOKEN_RATE})`);
      case 'modelFormat':
        return tx('模型 ID 只能包含字母、数字和 . _ : / @ + -，最长 128 个字符', 'Model ids use letters, digits and . _ : / @ + - (up to 128 characters)');
      case 'providerFormat':
        return tx('提供方 ID 只能包含小写字母、数字、- 和 _', 'Provider ids use lowercase letters, digits, - and _');
      case 'labelFormat':
        return tx(`名称最长 ${MAX_LABEL} 个字符，不能包含控制字符`, `Names are up to ${MAX_LABEL} characters without control characters`);
      case 'duplicate':
        return tx('与上面的条目重复', 'Duplicates an entry above');
      case 'tooMany':
        return tx(`每类最多 ${MAX_ROWS} 条`, `At most ${MAX_ROWS} entries per kind`);
    }
  };
}

/** One bordered section per kind; the native `disabled` fieldset locks every control inside it. */
export function KindSection({ title, pinned, disabled, children }: { title: string; pinned: boolean; disabled: boolean; children: ReactNode }) {
  const tx = useText();
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md border p-4" disabled={disabled || pinned}>
      <legend className="flex flex-wrap items-center gap-2 px-1 text-sm font-medium">
        {title}
        {pinned && <StatusBadge tone="warning">{tx('环境变量锁定', 'Pinned by environment')}</StatusBadge>}
      </legend>
      {children}
    </fieldset>
  );
}

/** A text input with its own label (visually hidden) and inline error, for table rows. */
export function CellInput({
  id,
  label,
  value,
  error,
  onChange,
  list,
  numeric,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  list?: string;
  numeric?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="min-w-0">
      <Input
        id={id}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        inputMode={numeric ? 'decimal' : undefined}
        autoComplete="off"
        spellCheck={false}
        list={list}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function AddRowButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button size="sm" icon={<Plus />} disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  );
}

export function RemoveRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="icon" variant="ghost" aria-label={label} title={label} onClick={onClick}>
      <Trash2 />
    </Button>
  );
}
