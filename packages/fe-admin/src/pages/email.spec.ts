import { describe, expect, it } from 'vitest';
import { MAIL_PREVIEW_CSP, previewDocument } from './email';

describe('mail template preview', () => {
  it('wraps the markup in a document whose CSP blocks remote loads', () => {
    const doc = new DOMParser().parseFromString(previewDocument('<p>Hi</p><img src="https://tracker.invalid/p.gif">'), 'text/html');
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toBe(MAIL_PREVIEW_CSP);
    expect(MAIL_PREVIEW_CSP).toContain("default-src 'none'");
    expect(MAIL_PREVIEW_CSP).not.toMatch(/https?:/);
    expect(doc.body.querySelector('p')?.textContent).toBe('Hi');
  });
});
