import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  summarizeAIResult,
  PrismaOperationLogObserver,
  type OperationLogSink,
  type OperationLogEntry,
  PersistedCostTracker,
  type CostPersister,
  type AggregatedCostRecord,
} from './index';
import type { AICallSuccessEvent, AICallErrorEvent } from '../call-observer';

describe('summarizeAIResult', () => {
  it('handles ChatCompletion shape', () => {
    const r = {
      id: 'cc-1',
      model: 'gpt-4',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const s = summarizeAIResult(r);
    expect(s.kind).toBe('chat');
    expect(s.id).toBe('cc-1');
    expect(s.contentLength).toBe(5);
    expect(s.contentPreview).toBe('hello');
    expect(s.finishReason).toBe('stop');
    expect(s.hasContent).toBe(true);
  });

  it('handles stream result shape', () => {
    const r = { content: 'streamed text', chunkCount: 3, durationMs: 250, usage: {} };
    const s = summarizeAIResult(r);
    expect(s.kind).toBe('stream');
    expect(s.chunkCount).toBe(3);
    expect(s.contentLength).toBe(13);
  });

  it('handles embedding shape', () => {
    const r = { model: 'text-embedding-3-small', data: [{ embedding: [0.1, 0.2, 0.3] }], usage: {} };
    const s = summarizeAIResult(r);
    expect(s.kind).toBe('embedding');
    expect(s.summary).toContain('维度=3');
  });

  it('truncates long content with marker', () => {
    const longContent = 'a'.repeat(500);
    const r = { id: 'x', model: 'm', choices: [{ message: { content: longContent } }] };
    const s = summarizeAIResult(r, { previewMax: 50 });
    expect(s.contentPreview?.length).toBeLessThan(longContent.length);
    expect(s.contentPreview).toMatch(/总长度: 500/);
  });

  it('falls back to summary for unknown shape', () => {
    const s = summarizeAIResult({ random: 'thing' });
    expect(s.kind).toBe('unknown');
    expect(s.summary).toContain('random');
  });
});

describe('PrismaOperationLogObserver', () => {
  let entries: OperationLogEntry[];
  let sink: OperationLogSink;

  beforeEach(() => {
    entries = [];
    sink = { log: async (e) => { entries.push(e); } };
  });

  it('logs success with summarized response', async () => {
    const observer = new PrismaOperationLogObserver(sink);
    const event: AICallSuccessEvent = {
      context: 'dossier.vision',
      startTime: 0,
      durationMs: 1234,
      attempt: 1,
      result: { id: 'a', model: 'm', choices: [{ message: { content: 'ok' } }] },
      metadata: { userId: 'u1', dossierId: 'd1' },
    };
    await observer.onSuccess(event);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'ai',
      action: 'dossier.vision',
      status: 'SUCCESS',
      durationMs: 1234,
      userId: 'u1',
    });
    expect(entries[0].responseData).toMatchObject({ id: 'a' });
  });

  it('respects custom userIdKey/targetIdKey', async () => {
    const observer = new PrismaOperationLogObserver(sink, {
      userIdKey: 'callerId',
      targetIdKey: 'dossierId',
    });
    const event: AICallSuccessEvent = {
      context: 'x',
      startTime: 0,
      durationMs: 1,
      attempt: 1,
      result: { content: 'c', chunkCount: 1, durationMs: 1 },
      metadata: { callerId: 'who', dossierId: 'D-42' },
    };
    await observer.onSuccess(event);
    expect(entries[0].userId).toBe('who');
    expect(entries[0].targetId).toBe('D-42');
  });

  it('logs error with errorMessage', async () => {
    const observer = new PrismaOperationLogObserver(sink);
    const event: AICallErrorEvent = {
      context: 'x',
      startTime: 0,
      durationMs: 50,
      attempt: 2,
      error: new Error('boom'),
      metadata: {},
    };
    await observer.onError(event);
    expect(entries[0].status).toBe('FAILED');
    expect(entries[0].errorMessage).toBe('boom');
    expect(entries[0].metadata?.attempt).toBe(2);
  });

  it('does not throw when sink fails', async () => {
    const failingSink: OperationLogSink = {
      log: async () => { throw new Error('db down'); },
    };
    const observer = new PrismaOperationLogObserver(failingSink);
    const event: AICallSuccessEvent = {
      context: 'x',
      startTime: 0,
      durationMs: 1,
      attempt: 1,
      result: { id: '1', model: 'm', choices: [{ message: { content: '' } }] },
    };
    // 不应抛
    await expect(observer.onSuccess(event)).resolves.toBeUndefined();
  });
});

describe('PersistedCostTracker', () => {
  it('aggregates and flushes via persister', async () => {
    const persisted: AggregatedCostRecord[] = [];
    const persister: CostPersister = {
      persist: async (records) => { persisted.push(...records); },
    };

    const tracker = new PersistedCostTracker(persister, {
      perCallWarnThresholdUsd: 100, // 不触发告警
      sessionWarnThresholdUsd: 100,
    });

    tracker.record({
      timestamp: Date.now(),
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.01,
      duration: 200,
      scenario: 'test',
      modelRecordId: 'rec-1',
    } as any);

    tracker.record({
      timestamp: Date.now(),
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      cost: 0.02,
      duration: 300,
      scenario: 'test',
      modelRecordId: 'rec-1',
    } as any);

    await tracker.flush();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      modelId: 'gpt-4',
      modelRecordId: 'rec-1',
      requestCount: 2,
      successCount: 2,
      inputTokens: 300,
      outputTokens: 150,
      totalCost: 0.03,
      avgResponseTime: 250,
    });
  });

  it('skips entries without modelRecordId by default', async () => {
    const persisted: AggregatedCostRecord[] = [];
    const persister: CostPersister = {
      persist: async (records) => { persisted.push(...records); },
    };
    const tracker = new PersistedCostTracker(persister);

    tracker.record({
      timestamp: Date.now(),
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 1, outputTokens: 1, totalTokens: 2,
      cost: 0.001, duration: 1, scenario: 's',
    } as any);

    await tracker.flush();
    expect(persisted).toHaveLength(0);
  });

  it('triggers per-call warning over threshold', () => {
    const persister: CostPersister = { persist: async () => {} };
    const tracker = new PersistedCostTracker(persister, {
      perCallWarnThresholdUsd: 0.01,
    });
    const warn = vi.spyOn((tracker as any)._logger, 'warn');

    tracker.record({
      timestamp: Date.now(), provider: 'p', model: 'm',
      inputTokens: 1, outputTokens: 1, totalTokens: 2,
      cost: 0.5, duration: 1,
    } as any);

    expect(warn).toHaveBeenCalled();
  });

  it('manualFlush triggers persist', async () => {
    const persisted: AggregatedCostRecord[] = [];
    const persister: CostPersister = {
      persist: async (records) => { persisted.push(...records); },
    };
    const tracker = new PersistedCostTracker(persister);
    tracker.record({
      timestamp: Date.now(), provider: 'p', model: 'm',
      inputTokens: 1, outputTokens: 1, totalTokens: 2,
      cost: 0.001, duration: 1, modelRecordId: 'r',
    } as any);
    await tracker.manualFlush();
    expect(persisted).toHaveLength(1);
  });
});
