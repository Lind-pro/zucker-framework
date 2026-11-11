import assert from 'node:assert/strict';
import { test } from 'node:test';

const { qrMatrix, QR_QUIET_ZONE } = await import('./qr.ts');

const uri = 'otpauth://totp/Acme%20Studio:alice%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Acme%20Studio&algorithm=SHA1&digits=6&period=30';

function darkSet(path) {
  const cells = new Set();
  for (const match of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) cells.add(`${match[1] - QR_QUIET_ZONE},${match[2] - QR_QUIET_ZONE}`);
  return cells;
}

test('qrMatrix encodes an otpauth URI into a valid QR symbol with finder patterns', () => {
  const matrix = qrMatrix(uri);
  assert.ok(matrix);
  assert.ok(matrix.size >= 21 && (matrix.size - 17) % 4 === 0, `size ${matrix.size} is a QR version size`);
  assert.match(matrix.path, /^(M\d+ \d+h1v1h-1z)+$/);
  const dark = darkSet(matrix.path);
  // Finder pattern corners: a 7x7 dark ring with a light ring inside and a 3x3 dark core.
  for (const [ox, oy] of [[0, 0], [matrix.size - 7, 0], [0, matrix.size - 7]]) {
    for (let i = 0; i < 7; i += 1) {
      for (const [x, y] of [[ox + i, oy], [ox + i, oy + 6], [ox, oy + i], [ox + 6, oy + i]]) assert.ok(dark.has(`${x},${y}`));
    }
    assert.ok(!dark.has(`${ox + 1},${oy + 1}`));
    assert.ok(dark.has(`${ox + 3},${oy + 3}`));
  }
  // Deterministic: the same URI always renders the same symbol.
  assert.equal(qrMatrix(uri).path, matrix.path);
  assert.notEqual(qrMatrix(uri.replace('JBSW', 'KBSW')).path, matrix.path);
});

test('qrMatrix returns null instead of throwing for input it cannot render', () => {
  assert.equal(qrMatrix(''), null);
  assert.equal(qrMatrix('x'.repeat(2049)), null);
});
