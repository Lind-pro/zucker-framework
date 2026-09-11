import { describe, expect, it } from 'vitest';
import { inspectUserAgent } from './user-agent';

describe('inspectUserAgent', () => {
  it('returns nullable details without introducing localized labels for missing input', () => {
    expect(inspectUserAgent(null)).toEqual({
      browserName: null,
      browserVersion: null,
      osName: null,
      osVersion: null,
      deviceModel: null,
      deviceVendor: null,
      deviceType: 'desktop',
    });
  });

  it('exposes browser and OS versions so consumers can choose their display policy', () => {
    expect(
      inspectUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      ),
    ).toMatchObject({
      browserName: 'Chrome',
      browserVersion: '128.0.0.0',
      osName: 'Windows',
      deviceType: 'desktop',
    });
  });

  it('classifies mobile devices and crawler traffic', () => {
    expect(
      inspectUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ).deviceType,
    ).toBe('mobile');
    expect(inspectUserAgent('ExampleBot/1.0').deviceType).toBe('bot');
  });
});
