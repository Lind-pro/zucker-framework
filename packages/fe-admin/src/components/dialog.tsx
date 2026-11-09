import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAdminI18n } from '../i18n/context';
import { cn } from '../lib/cn';
import { Button, type ButtonProps } from './button';

const overlay =
  'fixed inset-0 z-50 bg-black/40';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Max width in px on larger screens; phones always use the full viewport. */
  width?: number;
  /** Prevent closing while a command is in flight. */
  busy?: boolean;
}

/**
 * Modal dialog: focus is trapped and restored by Radix, Escape closes unless busy, and the
 * dialog becomes a full-screen sheet below the md breakpoint.
 */
export function Dialog({ open, onOpenChange, title, description, children, footer, width = 560, busy = false }: DialogProps) {
  const { t } = useAdminI18n();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (!busy || next) && onOpenChange(next)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlay} />
        <DialogPrimitive.Content
          onInteractOutside={(event) => event.preventDefault()}
          className="admin-dialog fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-card text-card-foreground shadow-xl outline-none"
          style={{ ['--dialog-width' as string]: `${width}px` }}
        >
          <header data-slot="dialog-header" className="flex items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold leading-6">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{typeof title === 'string' ? title : ''}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              data-slot="dialog-close"
              disabled={busy}
              aria-label={t('common.close')}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 [&_svg]:size-4"
            >
              <X />
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <footer className="admin-dialog-footer flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Side sheet for details; full width on phones. */
export function Drawer({ open, onOpenChange, title, description, children, footer, width = 640, busy = false }: DialogProps) {
  const { t } = useAdminI18n();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (!busy || next) && onOpenChange(next)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlay} />
        <DialogPrimitive.Content
          className="admin-sheet fixed inset-y-0 right-0 z-50 flex h-dvh flex-col border-l bg-card text-card-foreground shadow-xl outline-none"
          style={{ ['--dialog-width' as string]: `${width}px` }}
        >
          <header data-slot="sheet-header" className="flex items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold leading-6">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className={description ? 'mt-1 text-sm text-muted-foreground' : 'sr-only'}>
                {description ?? (typeof title === 'string' ? title : '')}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              data-slot="sheet-close"
              disabled={busy}
              aria-label={t('common.close')}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4"
            >
              <X />
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">{footer}</footer>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmText?: ReactNode;
  destructive?: boolean;
  /** Resolve to close; throw (or return false) to keep the dialog open, e.g. after a failure toast. */
  onConfirm: () => Promise<boolean | void> | boolean | void;
}

/** Alert dialog: the cancel action receives initial focus so Enter does not confirm by accident. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmText, destructive, onConfirm }: ConfirmDialogProps) {
  const { t } = useAdminI18n();
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      if ((await onConfirm()) !== false) onOpenChange(false);
    } catch {
      /* The caller reports the failure; keep the dialog open for retry. */
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertPrimitive.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className={overlay} />
        <AlertPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-5 text-card-foreground shadow-xl outline-none">
          <AlertPrimitive.Title className="text-base font-semibold leading-6">{title}</AlertPrimitive.Title>
          <AlertPrimitive.Description className={cn('mt-2 text-sm leading-6 text-muted-foreground', !description && 'sr-only')}>
            {description ?? (typeof title === 'string' ? title : '')}
          </AlertPrimitive.Description>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertPrimitive.Cancel asChild>
              <Button disabled={busy}>{t('common.cancel')}</Button>
            </AlertPrimitive.Cancel>
            <Button variant={destructive ? 'danger' : 'primary'} loading={busy} onClick={() => void confirm()}>
              {confirmText ?? t('common.confirm')}
            </Button>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}

/** A button that asks for confirmation before running a command. */
export function ConfirmButton({
  title,
  description,
  confirmText,
  destructive,
  onConfirm,
  children,
  ...button
}: Omit<ConfirmDialogProps, 'open' | 'onOpenChange'> & Omit<ButtonProps, 'onClick' | 'title'> & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...button} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        confirmText={confirmText}
        destructive={destructive}
        onConfirm={onConfirm}
      />
    </>
  );
}
