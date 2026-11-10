import { describe, it, expect } from 'vitest';
import { buildAttachmentDisposition } from './content-disposition';

describe('buildAttachmentDisposition', () => {
  it('provides ASCII fallback and RFC 5987 UTF-8 filename', () => {
    expect(buildAttachmentDisposition('附图说明.docx', 'drawings.docx')).toBe(
      'attachment; filename="drawings.docx"; filename*=UTF-8\'\'%E9%99%84%E5%9B%BE%E8%AF%B4%E6%98%8E.docx',
    );
  });

  it('prevents response-header injection and quoted fallback breakouts', () => {
    expect(buildAttachmentDisposition('report\r\nX-Test: yes.docx', 'bad"name.docx')).toBe(
      'attachment; filename="bad_name.docx"; filename*=UTF-8\'\'report%0D%0AX-Test%3A%20yes.docx',
    );
  });
});
