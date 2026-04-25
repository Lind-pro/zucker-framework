import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StructuredLogger, LogLevel, registerTraceIdResolver } from './structured-logger';

describe('StructuredLogger', () => {
  let logger: StructuredLogger;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new StructuredLogger('TestModule');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    // Reset trace resolvers
    registerTraceIdResolver(() => undefined, () => undefined);
  });

  describe('JSON format output', () => {
    it('should output valid JSON to stdout for INFO level', () => {
      logger.log('test message');
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = (stdoutSpy.mock.calls[0][0] as string).trim();
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe('INFO');
      expect(parsed.message).toBe('test message');
      expect(parsed.module).toBe('TestModule');
      expect(parsed.timestamp).toBeDefined();
    });

    it('should output valid JSON to stderr for ERROR level', () => {
      logger.error('error msg');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = (stderrSpy.mock.calls[0][0] as string).trim();
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe('ERROR');
      expect(parsed.message).toBe('error msg');
    });

    it('should output WARN to stderr', () => {
      logger.warn('warn msg');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = (stderrSpy.mock.calls[0][0] as string).trim();
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe('WARN');
    });

    it('should include trace data in error output', () => {
      logger.error('fail', 'stack trace here');
      const output = (stderrSpy.mock.calls[0][0] as string).trim();
      const parsed = JSON.parse(output);
      expect(parsed.data).toEqual({ trace: 'stack trace here' });
    });
  });

  describe('log level filtering', () => {
    it('should suppress DEBUG when min level is INFO', () => {
      logger.setMinLevel(LogLevel.INFO);
      logger.debug('debug msg');
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('should allow WARN when min level is WARN', () => {
      logger.setMinLevel(LogLevel.WARN);
      logger.warn('warn msg');
      expect(stderrSpy).toHaveBeenCalled();
    });

    it('should suppress INFO when min level is WARN', () => {
      logger.setMinLevel(LogLevel.WARN);
      logger.log('info msg');
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('should allow DEBUG when min level is DEBUG', () => {
      logger.setMinLevel(LogLevel.DEBUG);
      logger.debug('debug msg');
      expect(stdoutSpy).toHaveBeenCalled();
    });
  });

  describe('debug sample rate', () => {
    it('should suppress all DEBUG when sample rate is 0', () => {
      logger.setDebugSampleRate(0);
      for (let i = 0; i < 10; i++) {
        logger.debug('sampled');
      }
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('should clamp sample rate between 0 and 1', () => {
      logger.setDebugSampleRate(2.0);
      logger.debug('msg');
      expect(stdoutSpy).toHaveBeenCalled();
    });
  });

  describe('traceId integration', () => {
    it('should include traceId when resolver is registered', () => {
      registerTraceIdResolver(() => 'trace-123', () => 'span-456');
      logger.log('traced');
      const output = (stdoutSpy.mock.calls[0][0] as string).trim();
      const parsed = JSON.parse(output);
      expect(parsed.traceId).toBe('trace-123');
      expect(parsed.spanId).toBe('span-456');
    });
  });

  describe('verbose', () => {
    it('should map verbose to DEBUG level', () => {
      logger.verbose('verbose msg');
      const output = (stdoutSpy.mock.calls[0][0] as string).trim();
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe('DEBUG');
    });
  });

  describe('context override', () => {
    it('should use context parameter as module when provided', () => {
      logger.log('msg', 'OverrideModule');
      const output = (stdoutSpy.mock.calls[0][0] as string).trim();
      const parsed = JSON.parse(output);
      expect(parsed.module).toBe('OverrideModule');
    });
  });
});
