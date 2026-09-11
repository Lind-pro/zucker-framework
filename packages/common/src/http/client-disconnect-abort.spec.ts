import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createClientDisconnectAbort } from './client-disconnect-abort';

function harness() {
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { writableEnded: false });
  const abort = createClientDisconnectAbort(req as never, res as never);
  return { req, res, abort };
}

describe('createClientDisconnectAbort', () => {
  it('aborts an active operation when the client disconnects', () => {
    const { req, abort } = harness();

    req.emit('aborted');

    expect(abort.signal.aborted).toBe(true);
  });

  it('does not abort after the response has completed', () => {
    const { res, abort } = harness();
    res.writableEnded = true;

    res.emit('close');

    expect(abort.signal.aborted).toBe(false);
  });

  it('removes listeners when disposed', () => {
    const { req, res, abort } = harness();

    abort.dispose();
    req.emit('aborted');
    res.emit('close');

    expect(abort.signal.aborted).toBe(false);
  });
});
