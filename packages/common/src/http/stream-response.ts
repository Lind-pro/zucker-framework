import type { Response } from 'express';
import type { Stream } from 'node:stream';

export interface StreamResponseOptions {
  logger?: { error(message: string, stack?: string): void; warn(message: string): void };
  context?: string;
  errorStatusCode?: number;
  errorBody?: unknown;
}

/**
 * Pipe a readable stream without an unhandled source error or abandoned work.
 * Before headers: send the configured JSON failure. After headers: destroy the
 * response, since a partially downloaded body cannot become a JSON error.
 */
export function pipeStreamToResponse(
  stream: Stream,
  res: Response,
  options: StreamResponseOptions = {},
): void {
  const {
    logger,
    context = 'stream',
    errorStatusCode = 500,
    errorBody = { message: 'Stream failed', error: 'STREAM_ERROR' },
  } = options;
  let failed = false;
  const destroySource = () => {
    if ('destroy' in stream && typeof stream.destroy === 'function') {
      try {
        stream.destroy();
      } catch (error) {
        logger?.warn(
          `[${context}] stream.destroy failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const onError = (error: Error) => {
    if (failed) return;
    failed = true;
    logger?.error(`[${context}] Stream error: ${error.message}`, error.stack);
    if ('unpipe' in stream && typeof stream.unpipe === 'function') stream.unpipe(res);
    if (!res.headersSent && !res.destroyed && !res.writableEnded) {
      // A controller may already have configured download headers.
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      res.status(errorStatusCode).json(errorBody);
    } else if (!res.destroyed) {
      res.destroy();
    }
    destroySource();
  };
  const onClose = () => {
    destroySource();
  };
  const onSourceEnd = () => {
    res.off('close', onClose);
  };
  stream.on('error', onError);
  stream.once('end', onSourceEnd);
  res.once('close', onClose);
  // Keep the error handler until source close: destroy() may emit asynchronously.
  stream.once('close', () => {
    stream.off('error', onError);
    stream.off('end', onSourceEnd);
    res.off('close', onClose);
  });
  try {
    stream.pipe(res);
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}
