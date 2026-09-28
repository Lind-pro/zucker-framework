import type { Request, Response } from 'express';

export interface ClientDisconnectAbort {
  signal: AbortSignal;
  dispose: () => void;
}

export function createClientDisconnectAbort(
  req: Pick<Request, 'once' | 'off'> & Partial<Pick<Request, 'aborted'>>,
  res: Pick<Response, 'once' | 'off' | 'writableEnded'> & Partial<Pick<Response, 'destroyed'>>,
  options: { reason?: () => unknown } = {},
): ClientDisconnectAbort {
  const controller = new AbortController();
  const abortOnDisconnect = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(options.reason?.() ?? new Error('client disconnected'));
    }
  };
  req.once('aborted', abortOnDisconnect);
  res.once('close', abortOnDisconnect);
  if (req.aborted || res.destroyed) abortOnDisconnect();

  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    },
  };
}
