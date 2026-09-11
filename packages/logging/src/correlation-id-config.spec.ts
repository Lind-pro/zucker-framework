// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CorrelationIdMiddleware, getCorrelationId } from './correlation-id';
describe('CorrelationIdMiddleware', () => {
  const middleware = new CorrelationIdMiddleware({
    headerName: 'X-Request-Id',
    requestProperty: 'requestId',
  });

  function invoke(value?: string | string[]) {
    const req = {
      headers: value === undefined ? {} : { 'x-request-id': value },
    } as { headers: Record<string, string | string[]>; requestId?: string };
    const res = { setHeader: vi.fn() };
    let correlationId: string | undefined;
    const next = vi.fn(() => {
      correlationId = getCorrelationId();
    });

    middleware.use(req, res, next);

    return { req, res, next, correlationId };
  }

  it('保留安全的客户端 Request ID，并传播到 framework 日志上下文', () => {
    const result = invoke('client.trace-123:child_4');

    expect(result.req.requestId).toBe('client.trace-123:child_4');
    expect(result.correlationId).toBe('client.trace-123:child_4');
    expect(result.res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client.trace-123:child_4');
    expect(result.next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['换行注入', 'unsafe\nforged-log-line'],
    ['空白字符', 'unsafe request id'],
    ['超长值', 'x'.repeat(129)],
    ['重复请求头', ['first', 'second']],
  ])('拒绝%s并生成服务端 UUID', (_label, value) => {
    const result = invoke(value);

    expect(result.req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.correlationId).toBe(result.req.requestId);
    expect(result.res.setHeader).toHaveBeenCalledWith('X-Request-Id', result.req.requestId);
  });

  it('请求头缺失时生成并回写服务端 UUID', () => {
    const result = invoke();

    expect(result.req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.correlationId).toBe(result.req.requestId);
  });
});
