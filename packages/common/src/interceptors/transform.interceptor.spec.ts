import { Controller, Get, Header, Sse, StreamableFile, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { RawResponse, TransformInterceptor } from './transform.interceptor';

describe('TransformInterceptor', () => {
  const context = {} as ExecutionContext;

  it('keeps file responses intact for the Nest HTTP adapter', async () => {
    const file = new StreamableFile(Buffer.from('download'), { type: 'application/octet-stream' });
    const response = await lastValueFrom(
      new TransformInterceptor().intercept(context, {
        handle: () => of(file),
      }),
    );
    expect(response).toBe(file);
  });

  it('retains the public JSON response envelope', async () => {
    const data = { id: 'example' };
    const response = await lastValueFrom(
      new TransformInterceptor().intercept(context, {
        handle: () => of(data),
      }),
    );
    expect(response).toEqual({
      status: 200,
      code: 'success',
      message: 'success',
      result: data,
      timestamp: expect.any(Number),
    });
  });

  describe('raw routes', () => {
    @Controller('x')
    class Routes {
      @Get('metrics') @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8') metrics() { return 'up 1\n'; }
      @Get('json') @Header('Content-Type', 'application/json') json() { return { ok: true }; }
      @Sse('events') events() { return null; }
      @Get('raw') @RawResponse() raw() { return { status: 'up' }; }
      @Get('plain') plain() { return 'value'; }
    }
    @RawResponse() @Controller('y')
    class RawController { @Get() body() { return { status: 'up' }; } }
    const http = (cls: object, handler: (...args: never[]) => unknown, headers: Record<string, string> = {}) => ({
      getType: () => 'http', getHandler: () => handler, getClass: () => cls,
      switchToHttp: () => ({ getResponse: () => ({ getHeader: (name: string) => headers[name.toLowerCase()] }) }),
    }) as unknown as ExecutionContext;
    const run = (context: ExecutionContext, value: unknown) =>
      lastValueFrom(new TransformInterceptor().intercept(context, { handle: () => of(value) }));

    it('passes through declared non-JSON content types, SSE and @RawResponse', async () => {
      const proto = Routes.prototype;
      expect(await run(http(Routes, proto.metrics), 'up 1\n')).toBe('up 1\n');
      expect(await run(http(Routes, proto.events), { data: 1 })).toEqual({ data: 1 });
      expect(await run(http(Routes, proto.raw), { status: 'up' })).toEqual({ status: 'up' });
      expect(await run(http(RawController, RawController.prototype.body), { status: 'up' })).toEqual({ status: 'up' });
    });
    it('passes through a non-JSON type set on the response; wraps JSON routes', async () => {
      const proto = Routes.prototype;
      expect(await run(http(Routes, proto.plain, { 'content-type': 'text/csv' }), 'a,b')).toBe('a,b');
      expect(await run(http(Routes, proto.json), { ok: true })).toMatchObject({ code: 'success', result: { ok: true } });
      expect(await run(http(Routes, proto.plain), 'value')).toMatchObject({ code: 'success', result: 'value' });
      expect(await run(http(Routes, proto.plain, { 'content-type': 'application/problem+json' }), 'v')).toMatchObject({ result: 'v' });
    });
  });
});
