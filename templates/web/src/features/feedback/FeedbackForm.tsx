'use client';
import { useId, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { FormMessage, buttonClass, panelClass } from '@/features/billing/components';
import { inputClass } from '@/app/[locale]/account/_components/AccountForm';
import { isDefiniteRejection, nextSubmitAttempt, type SubmitAttempt } from '@/features/ai/errors';
import { feedbackApi } from './api';
import { feedbackCopy } from './copy';
import { feedbackFailure, submission, validateFeedback } from './form-state';
import { FEEDBACK_MESSAGE_MAX, FEEDBACK_TYPES, type FeedbackItem, type FeedbackType } from './types';

/**
 * Feedback form. An uncertain failure (network, 5xx) keeps the Idempotency-Key, so retrying the same
 * text can never create a second item; a changed text or a definite 4xx gets a new key. The page the
 * user came from is attached only when given as a same-site `?from=` path.
 */
export function FeedbackForm({ onSent }: { onSent: (item: FeedbackItem) => void }) {
  const locale = useLocale(),
    text = feedbackCopy(locale),
    id = useId();
  const [type, setType] = useState<FeedbackType>('bug');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const attempt = useRef<SubmitAttempt | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const invalid = validateFeedback(type, message);
    if (invalid) {
      setNotice({ message: text.errors[invalid], error: true });
      return;
    }
    const from = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('from');
    const body = submission(type, message, from, locale);
    attempt.current = nextSubmitAttempt(attempt.current, JSON.stringify(body), () => `fb-${crypto.randomUUID()}`);
    setBusy(true);
    setNotice(null);
    try {
      const item = await feedbackApi.submit(body, attempt.current.key);
      attempt.current = null;
      setMessage('');
      setNotice({ message: text.sent, error: false });
      onSent(item);
    } catch (failure) {
      if (isDefiniteRejection(failure)) attempt.current = null;
      setNotice({ message: text.errors[feedbackFailure(failure)], error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`${panelClass} space-y-4`} onSubmit={(event) => void send(event)} aria-label={text.title} noValidate>
      <div className="space-y-2">
        <label htmlFor={`${id}-type`} className="block text-sm font-medium">
          {text.type}
        </label>
        <select id={`${id}-type`} className={inputClass} value={type} onChange={(event) => setType(event.target.value as FeedbackType)} disabled={busy}>
          {FEEDBACK_TYPES.map((value) => (
            <option key={value} value={value}>
              {text.types[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-message`} className="block text-sm font-medium">
          {text.message}
        </label>
        <textarea
          id={`${id}-message`}
          className={`${inputClass} min-h-36`}
          value={message}
          maxLength={FEEDBACK_MESSAGE_MAX}
          placeholder={text.placeholder}
          onChange={(event) => setMessage(event.target.value)}
          disabled={busy}
          required
          aria-describedby={`${id}-counter`}
        />
        <p id={`${id}-counter`} className="text-right text-xs text-[var(--color-muted)]">
          {text.counter(message.trim().length, FEEDBACK_MESSAGE_MAX)}
        </p>
      </div>
      {notice && <FormMessage message={notice.message} error={notice.error} />}
      <button type="submit" className={buttonClass} disabled={busy}>
        {busy ? text.sending : text.send}
      </button>
    </form>
  );
}
