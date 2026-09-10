import { StreamableFile, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { TransformInterceptor } from './transform.interceptor';

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
});
