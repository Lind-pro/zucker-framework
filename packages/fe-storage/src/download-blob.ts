/** Trigger an explicitly requested browser download and release its temporary DOM/URL resources. */
export function downloadBlob(
  blob: Blob,
  fileName: string,
  options: { revokeDelayMs?: number } = {},
): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('downloadBlob requires a browser');
  }
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    if (options.revokeDelayMs && options.revokeDelayMs > 0) {
      setTimeout(() => window.URL.revokeObjectURL(url), options.revokeDelayMs);
    } else {
      window.URL.revokeObjectURL(url);
    }
  }
}
