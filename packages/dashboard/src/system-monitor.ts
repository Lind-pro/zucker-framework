import * as os from 'os';
import type {
  Definition,
  ObjectDefinition,
  Measurement,
  MeasurementDimension,
  MeasurementProvider,
} from './measurement';
import { SimpleMeasurementValue, MeasurementParameter } from './measurement';
import { StaticMeasurement } from './dashboard';

/**
 * Built-in system monitor — CPU, Memory, Process measurements.
 *
 * Reference: jetlinks SystemMonitorMeasurementProvider
 */
export class SystemMonitorProvider implements MeasurementProvider {
  private readonly measurements: Map<string, Measurement>;

  constructor() {
    this.measurements = new Map();
    this.measurements.set('cpu', this.createCpuMeasurement());
    this.measurements.set('memory', this.createMemoryMeasurement());
    this.measurements.set('process', this.createProcessMeasurement());
  }

  getDashboardDefinition(): Definition {
    return { id: 'system', name: 'System Monitor' };
  }

  getObjectDefinition(): ObjectDefinition {
    return { id: 'stats', name: 'System Statistics' };
  }

  getMeasurements(): Measurement[] {
    return Array.from(this.measurements.values());
  }

  getMeasurement(id: string): Measurement | undefined {
    return this.measurements.get(id);
  }

  private createCpuMeasurement(): StaticMeasurement {
    return new StaticMeasurement({
      id: 'cpu',
      name: 'CPU',
      dimensions: [
        { id: 'usage', name: 'CPU Usage' },
        { id: 'count', name: 'CPU Count' },
      ],
    })
      .addDimension(this.createDimension('usage', 'CPU Usage', async () => {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;
        for (const cpu of cpus) {
          totalIdle += cpu.times.idle;
          totalTick += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
        }
        return SimpleMeasurementValue.of(totalTick > 0 ? 1 - totalIdle / totalTick : 0);
      }))
      .addDimension(this.createDimension('count', 'CPU Count', async () => {
        return SimpleMeasurementValue.of(os.cpus().length);
      }));
  }

  private createMemoryMeasurement(): StaticMeasurement {
    return new StaticMeasurement({
      id: 'memory',
      name: 'Memory',
      dimensions: [
        { id: 'total', name: 'Total Memory' },
        { id: 'used', name: 'Used Memory' },
        { id: 'free', name: 'Free Memory' },
        { id: 'usageRate', name: 'Memory Usage Rate' },
      ],
    })
      .addDimension(this.createDimension('total', 'Total Memory', async () => {
        return SimpleMeasurementValue.of(os.totalmem());
      }))
      .addDimension(this.createDimension('used', 'Used Memory', async () => {
        return SimpleMeasurementValue.of(os.totalmem() - os.freemem());
      }))
      .addDimension(this.createDimension('free', 'Free Memory', async () => {
        return SimpleMeasurementValue.of(os.freemem());
      }))
      .addDimension(this.createDimension('usageRate', 'Memory Usage Rate', async () => {
        const total = os.totalmem();
        const free = os.freemem();
        return SimpleMeasurementValue.of(total > 0 ? (total - free) / total : 0);
      }));
  }

  private createProcessMeasurement(): StaticMeasurement {
    return new StaticMeasurement({
      id: 'process',
      name: 'Process',
      dimensions: [
        { id: 'uptime', name: 'Uptime' },
        { id: 'rss', name: 'RSS Memory' },
        { id: 'heapUsed', name: 'Heap Used' },
        { id: 'heapTotal', name: 'Heap Total' },
      ],
    })
      .addDimension(this.createDimension('uptime', 'Uptime', async () => {
        return SimpleMeasurementValue.of(process.uptime());
      }))
      .addDimension(this.createDimension('rss', 'RSS Memory', async () => {
        return SimpleMeasurementValue.of(process.memoryUsage().rss);
      }))
      .addDimension(this.createDimension('heapUsed', 'Heap Used', async () => {
        return SimpleMeasurementValue.of(process.memoryUsage().heapUsed);
      }))
      .addDimension(this.createDimension('heapTotal', 'Heap Total', async () => {
        return SimpleMeasurementValue.of(process.memoryUsage().heapTotal);
      }));
  }

  private createDimension(
    id: string,
    name: string,
    getter: (params?: MeasurementParameter) => Promise<SimpleMeasurementValue>,
  ): MeasurementDimension {
    return {
      definition: { id, name },
      async getValue(params?: MeasurementParameter | Record<string, unknown>) {
        const p = params instanceof MeasurementParameter
          ? params
          : new MeasurementParameter(params);
        return getter(p);
      },
    };
  }
}
