import type { Request, Response } from 'express';

export interface ClientDisconnectAbort {
  signal: AbortSignal;
  dispose: () => void;
}

export function createClientDisconnectAbort(
  req: Pick<Request, 'once' | 'off'>,
  res: Pick<Response, 'once' | 'off' | 'writableEnded'>,
): ClientDisconnectAbort {
  const controller = new AbortController();
  const abortOnDisconnect = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error('client disconnected'));
    }
  };
  req.once('aborted', abortOnDisconnect);
  res.once('close', abortOnDisconnect);

  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    },
  };
}
