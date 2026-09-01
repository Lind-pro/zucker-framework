import { describe, it, expect, vi } from 'vitest';
import { CachedDataSourceSwitchStrategyMatcher } from './datasource-strategy';
import type { DataSourceSwitchStrategy } from './datasource-strategy';

function makeStrategy(id = 'ds1'): DataSourceSwitchStrategy {
  return { useDefaultDataSource: false, fallbackDefault: false, dataSourceId: id };
}

class TestMatcher extends CachedDataSourceSwitchStrategyMatcher {
  createStrategyIfMatch = vi.fn(
    (target: string, method: string): DataSourceSwitchStrategy | undefined => {
      if (target === 'UserService' && method === 'findAll') {
        return makeStrategy('secondary');
      }
      return undefined;
    },
  );
}

describe('CachedDataSourceSwitchStrategyMatcher', () => {
  it('match() 对有策略的 target/method 返回 true', () => {
    const matcher = new TestMatcher();
    expect(matcher.match('UserService', 'findAll')).toBe(true);
  });

  it('match() 对无策略的 target/method 返回 false', () => {
    const matcher = new TestMatcher();
    expect(matcher.match('UserService', 'unknown')).toBe(false);
  });

  it('match() 命中后 createStrategyIfMatch 只调用一次（缓存）', () => {
    const matcher = new TestMatcher();
    matcher.match('UserService', 'findAll');
    matcher.match('UserService', 'findAll');
    matcher.match('UserService', 'findAll');

    expect(matcher.createStrategyIfMatch).toHaveBeenCalledOnce();
  });

  it('getStrategy() 返回缓存的策略', () => {
    const matcher = new TestMatcher();
    matcher.match('UserService', 'findAll'); // 触发缓存

    const strategy = matcher.getStrategy('UserService', 'findAll');
    expect(strategy).toBeDefined();
    expect(strategy?.dataSourceId).toBe('secondary');
  });

  it('getStrategy() 未命中时返回 undefined', () => {
    const matcher = new TestMatcher();
    expect(matcher.getStrategy('UserService', 'findAll')).toBeUndefined();
  });

  it('不同 target#method 组合各自独立缓存', () => {
    const matcher = new TestMatcher();
    matcher.match('UserService', 'findAll');
    matcher.match('UserService', 'findAll');
    matcher.match('UserService', 'unknown');

    // findAll 命中缓存仅调用一次；unknown 未命中调用一次 => 共 2 次
    expect(matcher.createStrategyIfMatch).toHaveBeenCalledTimes(2);
  });

  it('策略中 useDefaultDataSource / fallbackDefault 字段被正确保存', () => {
    class CustomMatcher extends CachedDataSourceSwitchStrategyMatcher {
      createStrategyIfMatch = vi.fn((): DataSourceSwitchStrategy => ({
        useDefaultDataSource: true,
        fallbackDefault: true,
        dataSourceId: 'fallback-ds',
      }));
    }

    const matcher = new CustomMatcher();
    matcher.match('Any', 'method');
    const strategy = matcher.getStrategy('Any', 'method');

    expect(strategy?.useDefaultDataSource).toBe(true);
    expect(strategy?.fallbackDefault).toBe(true);
  });
});
