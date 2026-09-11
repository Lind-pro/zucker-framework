import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from './download-blob';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser blob download', () => {
  it('preserves a consumer-selected delay before URL revocation', () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = () => 'blob:delayed';
        static revokeObjectURL = revoke;
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    downloadBlob(new Blob(['synthetic']), 'report.docx', { revokeDelayMs: 1000 });
    expect(document.querySelector('a[download="report.docx"]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:delayed');
  });
  it('uses the chosen filename and releases the object URL even if clicking fails', () => {
    const create = vi.fn(() => 'blob:synthetic');
    const revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('report.csv');
      expect(this.href).toBe('blob:synthetic');
      throw new Error('blocked');
    });
    const blob = new Blob(['synthetic']);
    expect(() => downloadBlob(blob, 'report.csv')).toThrow('blocked');
    expect(create).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:synthetic');
    expect(document.querySelector('a[download="report.csv"]')).toBeNull();
  });
});
