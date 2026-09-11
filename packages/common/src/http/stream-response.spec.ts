import { EventEmitter } from 'node:events';
import type { Stream } from 'node:stream';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { pipeStreamToResponse } from './stream-response';

function harness() {
  const source = Object.assign(new EventEmitter(), {
    pipe: vi.fn(),
    unpipe: vi.fn(),
    destroy: vi.fn(),
  });
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    removeHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
    destroy: vi.fn(),
  });
  response.status.mockReturnValue(response);
  const logger = { error: vi.fn(), warn: vi.fn() };
  pipeStreamToResponse(source as unknown as Stream, response as unknown as Response, {
    logger,
    errorBody: { code: 'EXPORT_FAILED' },
  });
  return { source, response, logger };
}

describe('pipeStreamToResponse', () => {
  it('clears download headers and sends the configured JSON before bytes are sent', () => {
    const { source, response } = harness();
    source.emit('error', new Error('encode failed'));
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ code: 'EXPORT_FAILED' });
    expect(response.removeHeader).toHaveBeenCalledWith('Content-Type');
    expect(response.removeHeader).toHaveBeenCalledWith('Content-Length');
    expect(response.removeHeader).toHaveBeenCalledWith('Content-Disposition');
    expect(source.unpipe).toHaveBeenCalledWith(response);
    expect(source.destroy).toHaveBeenCalledTimes(1);
  });

  it('terminates a partial download without writing a second response', () => {
    const { source, response } = harness();
    response.headersSent = true;
    source.emit('error', new Error('encode failed'));
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
  });

  it('stops work on disconnect and keeps an error listener through async destruction', () => {
    const { source, response } = harness();
    response.destroyed = true;
    response.emit('close');
    expect(source.destroy).toHaveBeenCalledTimes(1);
    expect(() => source.emit('error', new Error('late destroy error'))).not.toThrow();
    source.emit('close');
    expect(source.listenerCount('error')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('removes the disconnect listener when the source is finished', () => {
    const { source, response } = harness();
    source.emit('end');
    response.emit('close');
    expect(source.destroy).not.toHaveBeenCalled();
  });
});
