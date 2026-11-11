'use client';
import { useMemo } from 'react';
import { QR_QUIET_ZONE, qrMatrix } from './qr';

/** Renders a QR code as inline SVG (black on white regardless of theme so scanners read it). */
export function QrCode({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  if (!matrix) return null;
  const side = matrix.size + QR_QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      className="rounded-lg"
      data-testid="two-factor-qr"
    >
      <rect width={side} height={side} fill="#fff" />
      <path d={matrix.path} fill="#000" />
    </svg>
  );
}
