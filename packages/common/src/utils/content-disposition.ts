/** RFC 5987 attachment header with a safe ASCII fallback. */
export function buildAttachmentDisposition(fileName: string, fallbackFileName?: string): string {
  const fallback = (fallbackFileName ?? fileName)
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[\r\n]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
