import { describe, it, expect, vi } from 'vitest';
import { DashboardManager, StaticMeasurement } from './dashboard';
import { MeasurementParameter, SimpleMeasurementValue } from './measurement';
import { SystemMonitorProvider } from './system-monitor';
import type {
  MeasurementProvider,
  MeasurementDimension,
  MeasurementDefinition,
} from './measurement';

// ────────────────────────────────────────────────────────────
// 辅助工厂
// ────────────────────────────────────────────────────────────

function makeDimension(id: string, value: unknown = 42): MeasurementDimension {
  return {
    definition: { id, name: id },
    getValue: vi.fn().mockResolvedValue(SimpleMeasurementValue.of(value)),
  };
}

function makeProvider(
  dashId: string,
  objId: string,
  measurementId: string,
  dimId = 'value',
): MeasurementProvider {
  const def: MeasurementDefinition = {
    id: measurementId,
    name: measurementId,
    dimensions: [{ id: dimId, name: dimId }],
  };
  const measurement = new StaticMeasurement(def).addDimension(makeDimension(dimId));

  return {
    getDashboardDefinition: () => ({ id: dashId, name: dashId }),
    getObjectDefinition: () => ({ id: objId, name: objId }),
    getMeasurements: () => [measurement],
    getMeasurement: (id: string) => (id === measurementId ? measurement : undefined),
  };
}

// ────────────────────────────────────────────────────────────
// MeasurementParameter
// ────────────────────────────────────────────────────────────

describe('MeasurementParameter — 参数访问', () => {
  it('get() 返回指定 key 的值', () => {
    const p = MeasurementParameter.of({ foo: 'bar' });
    expect(p.get('foo')).toBe('bar');
  });

  it('getString() 返回字符串，缺失时返回默认值', () => {
    const p = MeasurementParameter.of({ x: 123 });
    expect(p.getString('x')).toBe('123');
    expect(p.getString('missing', 'default')).toBe('default');
  });

  it('getNumber() 从字符串解析数字，非数字时返回默认值', () => {
    const p = MeasurementParameter.of({ n: '3.14', bad: 'abc' });
    expect(p.getNumber('n')).toBe(3.14);
    expect(p.getNumber('bad', -1)).toBe(-1);
  });

  it('values() 返回参数副本', () => {
    const raw = { a: 1, b: 2 };
    const p = MeasurementParameter.of(raw);
    const vals = p.values();
    expect(vals).toEqual(raw);
    // 副本不影响原始
    vals.a = 999;
    expect(p.get('a')).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// SimpleMeasurementValue
// ────────────────────────────────────────────────────────────

describe('SimpleMeasurementValue — 测量值', () => {
  it('of() 无 timestamp 时自动填充当前时间', () => {
    const before = Date.now();
    const v = SimpleMeasurementValue.of(99);
    const after = Date.now();
    expect(v.value).toBe(99);
    expect(v.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(v.timestamp.getTime()).toBeLessThanOrEqual(after);
  });

  it('of() 接受毫秒时间戳', () => {
    const ts = new Date(2024, 0, 1, 12, 0, 0).getTime();
    const v = SimpleMeasurementValue.of(1, ts);
    expect(v.timestamp.getTime()).toBe(ts);
  });

  it('timeString 格式为 YYYY-MM-DD HH:mm:ss', () => {
    const date = new Date(2024, 5, 15, 9, 3, 7); // 2024-06-15 09:03:07
    const v = SimpleMeasurementValue.of(0, date);
    expect(v.timeString).toBe('2024-06-15 09:03:07');
  });

  it('compareAsc 升序排列', () => {
    const a = SimpleMeasurementValue.of(1, 1000);
    const b = SimpleMeasurementValue.of(2, 2000);
    expect(SimpleMeasurementValue.compareAsc(a, b)).toBeLessThan(0);
    expect(SimpleMeasurementValue.compareAsc(b, a)).toBeGreaterThan(0);
  });

  it('compareDesc 降序排列（最新在前）', () => {
    const a = SimpleMeasurementValue.of(1, 1000);
    const b = SimpleMeasurementValue.of(2, 2000);
    expect(SimpleMeasurementValue.compareDesc(a, b)).toBeGreaterThan(0);
    expect(SimpleMeasurementValue.compareDesc(b, a)).toBeLessThan(0);
  });
});

// ────────────────────────────────────────────────────────────
// StaticMeasurement
// ────────────────────────────────────────────────────────────

describe('StaticMeasurement — 静态维度集合', () => {
  it('addDimension 后 getDimension 可按 id 查找', () => {
    const def: MeasurementDefinition = {
      id: 'cpu',
      name: 'CPU',
      dimensions: [{ id: 'usage', name: 'CPU Usage' }],
    };
    const m = new StaticMeasurement(def).addDimension(makeDimension('usage', 0.5));
    expect(m.getDimension('usage')).toBeDefined();
    expect(m.getDimension('missing')).toBeUndefined();
  });

  it('getDimensions 返回所有已注册维度', () => {
    const def: MeasurementDefinition = {
      id: 'm',
      name: 'M',
      dimensions: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    };
    const m = new StaticMeasurement(def)
      .addDimension(makeDimension('a'))
      .addDimension(makeDimension('b'));
    expect(m.getDimensions()).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────
// DashboardManager
// ────────────────────────────────────────────────────────────

describe('DashboardManager — Dashboard 注册与路由', () => {
  it('registerProvider 后可通过 getDashboard 找到对应 dashboard', () => {
    const mgr = new DashboardManager();
    mgr.registerProvider(makeProvider('system', 'cpu', 'cpu_metrics'));
    const dash = mgr.getDashboard('system');
    expect(dash).toBeDefined();
    expect(dash!.definition.id).toBe('system');
  });

  it('同一 dashboard 多个 provider 合并对象列表', () => {
    const mgr = new DashboardManager();
    mgr.registerProvider(makeProvider('system', 'cpu', 'cpu_metrics'));
    mgr.registerProvider(makeProvider('system', 'memory', 'mem_metrics'));
    const dash = mgr.getDashboard('system')!;
    const ids = dash.getObjects().map((o) => o.definition.id);
    expect(ids).toContain('cpu');
    expect(ids).toContain('memory');
  });

  it('getObject 路由到正确的 DashboardObject', () => {
    const mgr = new DashboardManager();
    mgr.registerProvider(makeProvider('system', 'cpu', 'cpu_metrics', 'usage'));
    const obj = mgr.getDashboard('system')!.getObject('cpu');
    expect(obj).toBeDefined();
    const m = obj!.getMeasurement('cpu_metrics');
    expect(m).toBeDefined();
  });

  it('getMeasurement 路由到正确的 Measurement', () => {
    const mgr = new DashboardManager();
    mgr.registerProvider(makeProvider('system', 'cpu', 'cpu_metrics'));
    const obj = mgr.getDashboard('system')!.getObject('cpu')!;
    expect(obj.getMeasurement('cpu_metrics')).toBeDefined();
    expect(obj.getMeasurement('nonexistent')).toBeUndefined();
  });

  it('register() 仅登记 definition，不覆盖已有 dashboard', () => {
    const mgr = new DashboardManager();
    mgr.registerProvider(makeProvider('system', 'cpu', 'cpu_metrics'));
    mgr.register({ id: 'system', name: 'System Monitor' }); // 已存在，不覆盖
    expect(mgr.getDashboard('system')!.getObjects()).toHaveLength(1);
  });

  it('unregister 移除 dashboard', () => {
    const mgr = new DashboardManager();
    mgr.register({ id: 'temp', name: 'Temp' });
    expect(mgr.getDashboard('temp')).toBeDefined();
    mgr.unregister('temp');
    expect(mgr.getDashboard('temp')).toBeUndefined();
  });

  it('getDashboards 返回所有已注册 dashboard', () => {
    const mgr = new DashboardManager();
    mgr.register({ id: 'a', name: 'A' });
    mgr.register({ id: 'b', name: 'B' });
    expect(mgr.getDashboards()).toHaveLength(2);
  });

  it('getDefinitions 返回所有 definition', () => {
    const mgr = new DashboardManager();
    mgr.register({ id: 'x', name: 'X' });
    const defs = mgr.getDefinitions();
    expect(defs.map((d) => d.id)).toContain('x');
  });
});

// ────────────────────────────────────────────────────────────
// SystemMonitorProvider — 系统监控指标
// ────────────────────────────────────────────────────────────

describe('SystemMonitorProvider — 系统监控指标', () => {
  const provider = new SystemMonitorProvider();

  it('dashboardDefinition id 为 system', () => {
    expect(provider.getDashboardDefinition().id).toBe('system');
  });

  it('objectDefinition id 为 stats', () => {
    expect(provider.getObjectDefinition().id).toBe('stats');
  });

  it('getMeasurements 返回 cpu / memory / process 三项', () => {
    const ids = provider.getMeasurements().map((m) => m.definition.id);
    expect(ids).toContain('cpu');
    expect(ids).toContain('memory');
    expect(ids).toContain('process');
  });

  it('CPU 维度包含 usage 和 count', () => {
    const cpu = provider.getMeasurement('cpu')!;
    expect(cpu.getDimension('usage')).toBeDefined();
    expect(cpu.getDimension('count')).toBeDefined();
  });

  it('cpu.count 维度返回数字（CPU 核数 > 0）', async () => {
    const dim = provider.getMeasurement('cpu')!.getDimension('count')!;
    const val = await dim.getValue();
    expect(typeof val.value).toBe('number');
    expect(val.value as number).toBeGreaterThan(0);
  });

  it('cpu.usage 维度值在 [0, 1] 之间', async () => {
    const dim = provider.getMeasurement('cpu')!.getDimension('usage')!;
    const val = await dim.getValue();
    expect(val.value as number).toBeGreaterThanOrEqual(0);
    expect(val.value as number).toBeLessThanOrEqual(1);
  });

  it('内存维度包含 total / used / free / usageRate', () => {
    const mem = provider.getMeasurement('memory')!;
    expect(mem.getDimension('total')).toBeDefined();
    expect(mem.getDimension('used')).toBeDefined();
    expect(mem.getDimension('free')).toBeDefined();
    expect(mem.getDimension('usageRate')).toBeDefined();
  });

  it('memory.usageRate 值在 [0, 1] 之间', async () => {
    const dim = provider.getMeasurement('memory')!.getDimension('usageRate')!;
    const val = await dim.getValue();
    expect(val.value as number).toBeGreaterThanOrEqual(0);
    expect(val.value as number).toBeLessThanOrEqual(1);
  });

  it('process 维度包含 uptime / rss / heapUsed / heapTotal', () => {
    const proc = provider.getMeasurement('process')!;
    expect(proc.getDimension('uptime')).toBeDefined();
    expect(proc.getDimension('rss')).toBeDefined();
    expect(proc.getDimension('heapUsed')).toBeDefined();
    expect(proc.getDimension('heapTotal')).toBeDefined();
  });

  it('process.uptime 返回正数（秒）', async () => {
    const dim = provider.getMeasurement('process')!.getDimension('uptime')!;
    const val = await dim.getValue();
    expect(val.value as number).toBeGreaterThan(0);
  });

  it('getValue 接受 Record 形式参数（兼容性测试）', async () => {
    const dim = provider.getMeasurement('cpu')!.getDimension('count')!;
    // 传入普通对象，内部会包装成 MeasurementParameter
    const val = await dim.getValue({ dummy: true });
    expect(val.value as number).toBeGreaterThan(0);
  });

  it('SystemMonitorProvider 注册到 DashboardManager 可通过路由找到 cpu.usage 维度', async () => {
    const mgr = new DashboardManager();
    mgr.registerProvider(new SystemMonitorProvider());

    const obj = mgr.getDashboard('system')!.getObject('stats');
    expect(obj).toBeDefined();

    const m = obj!.getMeasurement('cpu');
    expect(m).toBeDefined();

    const dim = m!.getDimension('usage');
    expect(dim).toBeDefined();

    const val = await dim!.getValue();
    expect(typeof val.value).toBe('number');
  });
});
