import { describe, it, expect } from 'vitest';
import { DefaultSwitcher, DataSourceSwitcher } from './datasource-switcher';

describe('DefaultSwitcher', () => {
  it('初始状态 current() 返回 undefined', () => {
    const sw = new DefaultSwitcher('datasource');
    sw.run(() => {
      expect(sw.current()).toBeUndefined();
    });
  });

  it('use(id) 后 current() 返回该 id', () => {
    const sw = new DefaultSwitcher('datasource');
    sw.run(() => {
      sw.use('ds1');
      expect(sw.current()).toBe('ds1');
    });
  });

  it('use 多次后 current() 返回最后一次 id（栈顶）', () => {
    const sw = new DefaultSwitcher('datasource');
    sw.run(() => {
      sw.use('ds1');
      sw.use('ds2');
      expect(sw.current()).toBe('ds2');
    });
  });

  it('useLast() 回退到上一个 id', () => {
    const sw = new DefaultSwitcher('datasource');
    sw.run(() => {
      sw.use('ds1');
      sw.use('ds2');
      sw.useLast();
      expect(sw.current()).toBe('ds1');
    });
  });

  it('useLast() 在空栈时不抛异常，current() 仍为 undefined', () => {
    const sw = new DefaultSwitcher('datasource');
    sw.run(() => {
      expect(() => sw.useLast()).not.toThrow();
      expect(sw.current()).toBeUndefined();
    });
  });

  it('useDefault() 后 current() 返回 undefined（DEFAULT_MARKER 被过滤）', () => {
    const sw = new DefaultSwitcher('datasource');
    sw.run(() => {
      sw.use('ds1');
      sw.useDefault();
      expect(sw.current()).toBeUndefined();
    });
  });

  it('useDefault() 后 useLast() 恢复为上一个 id', () => {
    const sw = new DefaultSwitcher('datasource');
    sw.run(() => {
      sw.use('ds1');
      sw.useDefault();
      sw.useLast();
      expect(sw.current()).toBe('ds1');
    });
  });

  it('reset() 清空历史，current() 回到 undefined', () => {
    const sw = new DefaultSwitcher('datasource');
    sw.run(() => {
      sw.use('ds1');
      sw.use('ds2');
      sw.reset();
      expect(sw.current()).toBeUndefined();
    });
  });

  it('run() 提供隔离上下文，不同 run 块互不干扰', () => {
    const sw = new DefaultSwitcher('datasource');

    let resultA: string | undefined;
    let resultB: string | undefined;

    sw.run(() => {
      sw.use('ds-A');
      resultA = sw.current();
    });

    sw.run(() => {
      resultB = sw.current(); // 新上下文，栈为空
    });

    expect(resultA).toBe('ds-A');
    expect(resultB).toBeUndefined();
  });

  it('runAsync() 异步隔离上下文', async () => {
    const sw = new DefaultSwitcher('datasource');

    const resultA = await sw.runAsync(async () => {
      sw.use('async-ds');
      return sw.current();
    });

    const resultB = await sw.runAsync(async () => sw.current());

    expect(resultA).toBe('async-ds');
    expect(resultB).toBeUndefined();
  });
});

describe('DataSourceSwitcher', () => {
  it('run() 隔离 datasource / schema / table 三个切换器', () => {
    const switcher = new DataSourceSwitcher();

    let ds: string | undefined;
    let schema: string | undefined;
    let table: string | undefined;

    switcher.run(() => {
      switcher.datasource.use('ds1');
      switcher.schema.use('public');
      switcher.table.use('orders');

      ds = switcher.datasource.current();
      schema = switcher.schema.current();
      table = switcher.table.current();
    });

    expect(ds).toBe('ds1');
    expect(schema).toBe('public');
    expect(table).toBe('orders');
  });

  it('run() 结束后三个切换器上下文均回到初始状态', () => {
    const switcher = new DataSourceSwitcher();

    switcher.run(() => {
      switcher.datasource.use('ds1');
      switcher.schema.use('s1');
      switcher.table.use('t1');
    });

    // 在 run 外部无上下文 => current() 均为 undefined
    expect(switcher.datasource.current()).toBeUndefined();
    expect(switcher.schema.current()).toBeUndefined();
    expect(switcher.table.current()).toBeUndefined();
  });

  it('runAsync() 异步隔离三切换器', async () => {
    const switcher = new DataSourceSwitcher();

    const result = await switcher.runAsync(async () => {
      switcher.datasource.use('async-ds');
      switcher.schema.use('async-schema');
      return {
        ds: switcher.datasource.current(),
        schema: switcher.schema.current(),
      };
    });

    expect(result.ds).toBe('async-ds');
    expect(result.schema).toBe('async-schema');
  });

  it('resetAll() 清空所有切换器历史', () => {
    const switcher = new DataSourceSwitcher();

    switcher.run(() => {
      switcher.datasource.use('ds1');
      switcher.schema.use('s1');
      switcher.table.use('t1');

      switcher.resetAll();

      expect(switcher.datasource.current()).toBeUndefined();
      expect(switcher.schema.current()).toBeUndefined();
      expect(switcher.table.current()).toBeUndefined();
    });
  });
});
