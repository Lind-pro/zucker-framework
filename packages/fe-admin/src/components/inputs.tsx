import { Checkbox as CheckboxPrimitive, Switch as SwitchPrimitive } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../lib/cn';

const control =
  'w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm text-foreground shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive';

export function Input({ className, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} data-slot="input" className={cn(control, 'h-9', className)} {...props} />;
}

export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} data-slot="textarea" className={cn(control, 'min-h-20 py-2 leading-6', className)} {...props} />;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Native select: accessible, keyboard friendly and usable on touch devices without a portal. */
export function Select({
  options,
  placeholder,
  className,
  ref,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  options: readonly SelectOption[];
  placeholder?: string;
  ref?: Ref<HTMLSelectElement>;
}) {
  return (
    <select ref={ref} data-slot="select" className={cn(control, 'h-9 pr-8', className)} {...props}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<CheckboxPrimitive.CheckboxProps, 'checked' | 'onCheckedChange'> & {
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-card shadow-xs',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {checked === 'indeterminate' ? <Minus className="size-3" /> : <Check className="size-3" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<SwitchPrimitive.SwitchProps, 'checked' | 'onCheckedChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}

export interface FieldProps {
  label: ReactNode;
  /** Render the control with ids wired for label, description and error. */
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  description?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  /** Inline layout for switches and checkboxes. */
  inline?: boolean;
}

/** Label, help text and error message bound to one control for assistive technology. */
export function Field({ label, description, error, required, children, className, inline }: FieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <div className={cn(inline && 'flex items-center gap-3')}>
        <label htmlFor={id} className={cn('block text-sm font-medium', !inline && 'mb-1.5')}>
          {label}
          {required && (
            <span className="ml-0.5 text-destructive" aria-hidden="true">
              *
            </span>
          )}
        </label>
        {children({ id, describedBy, invalid: Boolean(error) })}
      </div>
      {description && (
        <p id={descriptionId} className="text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs leading-5 text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
