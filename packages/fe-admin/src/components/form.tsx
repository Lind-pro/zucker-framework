import { useId, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useAdminI18n, type Translate } from '../i18n/context';
import { cn } from '../lib/cn';
import { Button } from './button';
import { Dialog } from './dialog';
import { Notice } from './feedback';
import { Field, Input, Select, Switch, Textarea, type SelectOption } from './inputs';

export type FormValues = Record<string, unknown>;
export type FormErrors = Partial<Record<string, string>>;

export type FieldType =
  | 'text'
  | 'email'
  | 'password'
  | 'number'
  | 'integer'
  | 'textarea'
  | 'select'
  | 'switch'
  | 'list'
  | 'datetime'
  | 'date';

export interface FieldSpec {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  description?: ReactNode;
  placeholder?: string;
  options?: readonly SelectOption[];
  disabled?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  rows?: number;
  autoComplete?: string;
  /** Hide the field without dropping its value. */
  hidden?: boolean;
  /** Span both columns in a two-column form. */
  wide?: boolean;
}

export interface FormState<V extends FormValues> {
  values: V;
  errors: FormErrors;
  setValue: (name: keyof V & string, value: unknown) => void;
  setValues: (values: Partial<V>) => void;
  setErrors: (errors: FormErrors) => void;
}

export function useFormState<V extends FormValues>(initial: V): FormState<V> {
  const [values, setAll] = useState<V>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  return {
    values,
    errors,
    setValue: (name, value) => {
      setAll((previous) => ({ ...previous, [name]: value }));
      setErrors((previous) => (previous[name] ? { ...previous, [name]: undefined } : previous));
    },
    setValues: (next) => setAll((previous) => ({ ...previous, ...next })),
    setErrors,
  };
}

const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);

/** Built-in field rules: required, email, numeric range, integer and length. */
export function validateFields(fields: readonly FieldSpec[], values: FormValues, t: Translate): FormErrors {
  const errors: FormErrors = {};
  for (const field of fields) {
    if (field.hidden || field.disabled) continue;
    const value = values[field.name];
    if (isBlank(value)) {
      if (field.required) errors[field.name] = t('common.required', { label: field.label });
      continue;
    }
    if (field.type === 'email' && typeof value === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))
      errors[field.name] = t('common.invalidEmail');
    if (field.type === 'number' || field.type === 'integer') {
      const number = Number(value);
      if (!Number.isFinite(number)) errors[field.name] = t('common.invalidNumber', { min: field.min ?? '-∞', max: field.max ?? '∞' });
      else if (field.type === 'integer' && !Number.isInteger(number)) errors[field.name] = t('common.invalidInteger');
      else if ((field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max))
        errors[field.name] = t('common.invalidNumber', { min: field.min ?? '-∞', max: field.max ?? '∞' });
    }
    if (field.maxLength && typeof value === 'string' && value.length > field.maxLength)
      errors[field.name] = t('common.tooLong', { max: field.maxLength });
  }
  return errors;
}

/** Convert a datetime-local value to ISO, or null when empty/invalid. */
export function localDateTimeToIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Convert an ISO timestamp to the value of a datetime-local input. */
export function isoToLocalDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** Split a list input on commas (ASCII or full-width) and new lines; blank items are dropped. */
export function parseListInput(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Text input for a string list. The typed text is kept as is while editing (so "a," can be followed
 * by a second item); the form value is always the parsed list, and blur normalizes the text.
 */
function ListInput({
  value,
  onChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: unknown; onChange: (items: string[]) => void }) {
  const format = (items: unknown) => (Array.isArray(items) ? items.join(', ') : typeof items === 'string' ? items : '');
  const [text, setText] = useState(() => format(value));
  return (
    <Input
      {...props}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(parseListInput(event.target.value));
      }}
      onBlur={() => setText(parseListInput(text).join(', '))}
    />
  );
}

/**
 * Focus the control of a field by name. Controls carry `data-field`; a Radix Switch/Checkbox keeps
 * a hidden native input with the same `name`, so the visible control is preferred.
 */
export function focusField(root: ParentNode, name: string): void {
  if (!name) return;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(name) : name.replace(/["\\]/g, '\\$&');
  const target =
    root.querySelector<HTMLElement>(`[data-field="${escaped}"]`) ??
    root.querySelector<HTMLElement>(`[name="${escaped}"]:not([aria-hidden="true"]):not([type="hidden"])`);
  target?.focus();
}

export function FormField({ field, form }: { field: FieldSpec; form: FormState<FormValues> }) {
  const value = form.values[field.name];
  const error = form.errors[field.name];
  const type = field.type ?? 'text';
  if (field.hidden) return null;
  return (
    <Field
      label={field.label}
      description={field.description}
      error={error}
      required={field.required}
      inline={type === 'switch'}
      className={cn(field.wide && 'sm:col-span-2')}
    >
      {({ id, describedBy, invalid }) => {
        const common = {
          id,
          name: field.name,
          'data-field': field.name,
          'aria-describedby': describedBy,
          'aria-invalid': invalid || undefined,
          'aria-required': field.required || undefined,
          disabled: field.disabled,
        };
        if (type === 'switch')
          return <Switch {...common} checked={value === true} onCheckedChange={(checked) => form.setValue(field.name, checked)} />;
        if (type === 'textarea')
          return (
            <Textarea
              {...common}
              rows={field.rows ?? 3}
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              value={typeof value === 'string' ? value : value == null ? '' : String(value)}
              onChange={(event) => form.setValue(field.name, event.target.value)}
            />
          );
        if (type === 'select')
          return (
            <Select
              {...common}
              options={field.options ?? []}
              // A required select still needs an empty option until a value is chosen; otherwise the
              // browser displays the first option while the form value stays empty.
              placeholder={
                field.required && (field.options ?? []).some((option) => option.value === String(value ?? ''))
                  ? undefined
                  : (field.placeholder ?? '—')
              }
              value={value == null ? '' : String(value)}
              onChange={(event) => form.setValue(field.name, event.target.value || null)}
            />
          );
        if (type === 'list')
          return (
            <ListInput {...common} placeholder={field.placeholder} value={value} onChange={(items) => form.setValue(field.name, items)} />
          );
        return (
          <Input
            {...common}
            type={
              type === 'integer' || type === 'number'
                ? 'number'
                : type === 'datetime'
                  ? 'datetime-local'
                  : type === 'date'
                    ? 'date'
                    : type
            }
            inputMode={type === 'integer' ? 'numeric' : type === 'number' ? 'decimal' : undefined}
            step={type === 'integer' ? 1 : type === 'number' ? 'any' : undefined}
            min={field.min}
            max={field.max}
            maxLength={field.maxLength}
            autoComplete={field.autoComplete ?? (type === 'password' ? 'new-password' : 'off')}
            placeholder={field.placeholder}
            value={value == null ? '' : String(value)}
            onChange={(event) => form.setValue(field.name, event.target.value)}
          />
        );
      }}
    </Field>
  );
}

export function FormFields({ fields, form, columns = 1 }: { fields: readonly FieldSpec[]; form: FormState<FormValues>; columns?: 1 | 2 }) {
  return (
    <div className={cn('grid gap-4', columns === 2 && 'sm:grid-cols-2')}>
      {fields.map((field) => (
        <FormField key={field.name} field={field} form={form} />
      ))}
    </div>
  );
}

export interface FormDialogProps<V extends FormValues> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  initialValues: V;
  fields?: readonly FieldSpec[];
  columns?: 1 | 2;
  /** Extra validation merged with the built-in field rules. */
  validate?: (values: V) => FormErrors;
  /** Return false (or throw) to keep the dialog open with the draft preserved. */
  onSubmit: (values: V) => Promise<boolean | void> | boolean | void;
  submitText?: ReactNode;
  /** Custom content (e.g. nested editors) rendered after the fields. */
  children?: (form: FormState<V>) => ReactNode;
  width?: number;
  /** Shown above the fields when a submission fails. */
  failureMessage?: ReactNode;
}

/**
 * Modal form: keeps the draft when the command fails, blocks closing while submitting and moves
 * focus to the first invalid field after validation.
 */
export function FormDialog<V extends FormValues>(props: FormDialogProps<V>) {
  // Remount for each opening so the draft starts from the current initial values.
  return props.open ? <FormDialogBody {...props} /> : null;
}

function FormDialogBody<V extends FormValues>({
  open,
  onOpenChange,
  title,
  description,
  initialValues,
  fields = [],
  columns = 1,
  validate,
  onSubmit,
  submitText,
  children,
  width,
  failureMessage,
}: FormDialogProps<V>) {
  const { t } = useAdminI18n();
  const form = useFormState<V>(initialValues);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const formId = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const errors = { ...validateFields(fields, form.values, t), ...validate?.(form.values) };
    const invalid = Object.entries(errors).filter(([, message]) => message);
    form.setErrors(errors);
    if (invalid.length) {
      focusField(event.currentTarget as HTMLFormElement, invalid[0]?.[0] ?? '');
      return;
    }
    setSubmitting(true);
    setFailed(false);
    try {
      const result = await onSubmit(form.values);
      if (result === false) setFailed(Boolean(failureMessage));
      else onOpenChange(false);
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      busy={submitting}
      width={width ?? (columns === 2 ? 720 : 560)}
      footer={
        <>
          <Button disabled={submitting} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={submitting}>
            {submitText ?? t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={(event) => void submit(event)} className="space-y-4">
        {failed && <Notice tone="danger" title={failureMessage ?? t('common.saveFailed')} />}
        {fields.length > 0 && <FormFields fields={fields} form={form as unknown as FormState<FormValues>} columns={columns} />}
        {children?.(form)}
      </form>
    </Dialog>
  );
}
