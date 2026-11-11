import qrcode from 'qrcode-generator';

export interface QrMatrix {
  /** Modules per side, quiet zone excluded. */
  size: number;
  /** One SVG path of 1×1 squares for the dark modules, in module units (offset by the quiet zone). */
  path: string;
}

/** Quiet zone in modules; the QR specification asks for four. */
export const QR_QUIET_ZONE = 4;

/**
 * Encodes text as a QR code entirely in the browser (no image service: the payload is a 2FA secret).
 * Error correction M keeps an otpauth URI (~120 chars) around version 7. Returns null for input the
 * library cannot encode, so callers fall back to the text key.
 */
export function qrMatrix(text: string): QrMatrix | null {
  if (!text || text.length > 2048) return null;
  try {
    const code = qrcode(0, 'M');
    code.addData(text, 'Byte');
    code.make();
    const size = code.getModuleCount();
    let path = '';
    for (let row = 0; row < size; row += 1)
      for (let col = 0; col < size; col += 1)
        if (code.isDark(row, col)) path += `M${col + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h1v1h-1z`;
    return { size, path };
  } catch {
    return null;
  }
}
