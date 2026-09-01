import { getProcessUptime } from './process-uptime';

describe('getProcessUptime', () => {
  it('returns explicit millisecond and second values', () => {
    expect(getProcessUptime(1_000, 3_450)).toEqual({
      uptimeMs: 2_450,
      uptimeSeconds: 2,
    });
  });

  it('does not return a negative duration when the wall clock moves back', () => {
    expect(getProcessUptime(2_000, 1_000)).toEqual({
      uptimeMs: 0,
      uptimeSeconds: 0,
    });
  });
});
