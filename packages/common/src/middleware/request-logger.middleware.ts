import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/** Middleware that logs HTTP request method, URL, status code, and response time. */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      // Log the path only: query strings can carry tokens, signed URLs or personal data.
      const url = req.originalUrl ?? req.url ?? '';
      const queryIndex = url.indexOf('?');
      const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
      this.logger.log(`${req.method} ${path} ${res.statusCode} ${duration}ms`);
    });
    next();
  }
}
