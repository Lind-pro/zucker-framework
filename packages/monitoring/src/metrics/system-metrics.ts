import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as os from 'os';
import { MetricsRegistry } from './metrics-registry';

export interface SystemMetricsOptions {
  /** 采集间隔（毫秒），默认 15000 */
  intervalMs?: number;
  /** 是否启用，默认 true */
  enabled?: boolean;
  /** 采集前缀，默认无 */
  prefix?: string;
}

/**
 * 系统指标采集器：CPU、内存、进程 uptime、事件循环延迟、GC、活跃句柄
 */
@Injectable()
export class SystemMetricsCollector implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private options: Required<SystemMetricsOptions>;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuUsageTime: bigint | null = null;

  constructor(private readonly registry: MetricsRegistry) {
    this.options = { intervalMs: 15000, enabled: true, prefix: '' };
  }

  configure(options: SystemMetricsOptions): void {
    this.options = { ...this.options, ...options };
  }

  onModuleInit(): void {
    if (!this.options.enabled) return;
    this.collect();
    this.intervalHandle = setInterval(() => this.collect(), this.options.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private metricName(name: string): string {
    return this.options.prefix ? `${this.options.prefix}_${name}` : name;
  }

  collect(): void {
    this.collectCpuMetrics();
    this.collectMemoryMetrics();
    this.collectProcessMetrics();
    this.collectUptimeMetrics();
    this.measureEventLoopDelay();
    this.collectHandleMetrics();
  }

  private collectCpuMetrics(): void {
    // 系统 CPU
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      const times = cpu.times;
      totalIdle += times.idle;
      totalTick += times.user + times.nice + times.sys + times.irq + times.idle;
    }
    const cpuUsage = totalTick > 0 ? 1 - totalIdle / totalTick : 0;
    this.registry.gauge(this.metricName('system_cpu_usage'), 'System CPU usage ratio').set(cpuUsage);
    this.registry.gauge(this.metricName('system_cpu_count'), 'Number of CPUs').set(cpus.length);

    // 进程 CPU（更精确，基于 process.cpuUsage）
    const currentCpuUsage = process.cpuUsage();
    const now = process.hrtime.bigint();
    if (this.lastCpuUsage && this.lastCpuUsageTime) {
      const elapsedMicros = Number(now - this.lastCpuUsageTime) / 1000;
      if (elapsedMicros > 0) {
        const userDiff = currentCpuUsage.user - this.lastCpuUsage.user;
        const systemDiff = currentCpuUsage.system - this.lastCpuUsage.system;
        const processCpuUsage = (userDiff + systemDiff) / elapsedMicros;
        this.registry
          .gauge(this.metricName('process_cpu_usage'), 'Process CPU usage ratio')
          .set(Math.min(1, processCpuUsage));
        this.registry
          .gauge(this.metricName('process_cpu_user_seconds_total'), 'Process CPU user time total')
          .set(currentCpuUsage.user / 1e6);
        this.registry
          .gauge(this.metricName('process_cpu_system_seconds_total'), 'Process CPU system time total')
          .set(currentCpuUsage.system / 1e6);
      }
    }
    this.lastCpuUsage = currentCpuUsage;
    this.lastCpuUsageTime = now;
  }

  private collectMemoryMetrics(): void {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    this.registry.gauge(this.metricName('system_memory_total_bytes'), 'Total system memory').set(totalMem);
    this.registry.gauge(this.metricName('system_memory_free_bytes'), 'Free system memory').set(freeMem);
    this.registry.gauge(this.metricName('system_memory_used_bytes'), 'Used system memory').set(totalMem - freeMem);
  }

  private collectProcessMetrics(): void {
    const memUsage = process.memoryUsage();
    this.registry.gauge(this.metricName('process_memory_rss_bytes'), 'Process RSS').set(memUsage.rss);
    this.registry.gauge(this.metricName('process_memory_heap_total_bytes'), 'Process heap total').set(memUsage.heapTotal);
    this.registry.gauge(this.metricName('process_memory_heap_used_bytes'), 'Process heap used').set(memUsage.heapUsed);
    this.registry.gauge(this.metricName('process_memory_external_bytes'), 'Process external memory').set(memUsage.external);
    if (memUsage.arrayBuffers !== undefined) {
      this.registry
        .gauge(this.metricName('process_memory_array_buffers_bytes'), 'Process ArrayBuffers memory')
        .set(memUsage.arrayBuffers);
    }
  }

  private collectUptimeMetrics(): void {
    const processUptime = process.uptime();
    this.registry.gauge(this.metricName('process_uptime_seconds'), 'Process uptime').set(processUptime);

    let systemUptime = 0;
    try {
      systemUptime = os.uptime();
    } catch {
      systemUptime = 0;
    }

    this.registry.gauge(this.metricName('system_uptime_seconds'), 'System uptime').set(systemUptime);
    this.registry
      .gauge(this.metricName('process_start_time_seconds'), 'Process start time (Unix epoch)')
      .set(Math.floor(Date.now() / 1000 - processUptime));
  }

  private measureEventLoopDelay(): void {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const delay = Number(process.hrtime.bigint() - start) / 1e6; // ms
      this.registry.gauge(this.metricName('process_event_loop_delay_ms'), 'Event loop delay').set(delay);
    });
  }

  private collectHandleMetrics(): void {
    // Active handles and requests (Node.js internals)
    const activeHandles = (process as any)._getActiveHandles?.()?.length;
    const activeRequests = (process as any)._getActiveRequests?.()?.length;

    if (typeof activeHandles === 'number') {
      this.registry
        .gauge(this.metricName('process_active_handles'), 'Number of active handles')
        .set(activeHandles);
    }
    if (typeof activeRequests === 'number') {
      this.registry
        .gauge(this.metricName('process_active_requests'), 'Number of active requests')
        .set(activeRequests);
    }
  }
}
