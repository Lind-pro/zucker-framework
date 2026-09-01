import { Injectable } from '@nestjs/common';
import type {
  Definition,
  ObjectDefinition,
  Dashboard,
  DashboardObject,
  Measurement,
  MeasurementDimension,
  MeasurementProvider,
  MeasurementDefinition,
} from './measurement';

export interface DashboardDefinition extends Definition {}

/**
 * StaticMeasurement — a measurement built from a static set of dimensions.
 *
 * Reference: jetlinks StaticMeasurement
 */
export class StaticMeasurement implements Measurement {
  readonly definition: MeasurementDefinition;
  private readonly dimensions = new Map<string, MeasurementDimension>();

  constructor(definition: MeasurementDefinition) {
    this.definition = definition;
  }

  addDimension(dimension: MeasurementDimension): this {
    this.dimensions.set(dimension.definition.id, dimension);
    return this;
  }

  getDimensions(): MeasurementDimension[] {
    return Array.from(this.dimensions.values());
  }

  getDimension(id: string): MeasurementDimension | undefined {
    return this.dimensions.get(id);
  }
}

/**
 * CompositeDashboardObject — aggregates measurements from multiple providers.
 *
 * Reference: jetlinks CompositeDashboardObject
 */
class CompositeDashboardObject implements DashboardObject {
  definition!: ObjectDefinition;
  private readonly providers: MeasurementProvider[] = [];

  addProvider(provider: MeasurementProvider): void {
    if (!this.definition) {
      this.definition = provider.getObjectDefinition();
    }
    this.providers.push(provider);
  }

  getMeasurements(): Measurement[] {
    return this.providers.flatMap((p) => p.getMeasurements());
  }

  getMeasurement(id: string): Measurement | undefined {
    for (const provider of this.providers) {
      const m = provider.getMeasurement(id);
      if (m) return m;
    }
    return undefined;
  }
}

/**
 * CompositeDashboard — aggregates objects from providers and sub-dashboards.
 *
 * Reference: jetlinks CompositeDashboard
 */
class CompositeDashboard implements Dashboard {
  readonly definition: DashboardDefinition;
  private readonly objects = new Map<string, CompositeDashboardObject>();
  private readonly subDashboards: Dashboard[] = [];

  constructor(definition: DashboardDefinition) {
    this.definition = definition;
  }

  addProvider(provider: MeasurementProvider): void {
    const objId = provider.getObjectDefinition().id;
    let obj = this.objects.get(objId);
    if (!obj) {
      obj = new CompositeDashboardObject();
      this.objects.set(objId, obj);
    }
    obj.addProvider(provider);
  }

  addDashboard(dashboard: Dashboard): void {
    this.subDashboards.push(dashboard);
  }

  getObjects(): DashboardObject[] {
    const objs: DashboardObject[] = Array.from(this.objects.values());
    for (const sub of this.subDashboards) {
      objs.push(...sub.getObjects());
    }
    return objs;
  }

  getObject(id: string): DashboardObject | undefined {
    const obj = this.objects.get(id);
    if (obj) return obj;
    for (const sub of this.subDashboards) {
      const found = sub.getObject(id);
      if (found) return found;
    }
    return undefined;
  }
}

/**
 * DashboardManager — registers providers and dashboards, routes lookups.
 *
 * Reference: jetlinks DefaultDashboardManager
 */
@Injectable()
export class DashboardManager {
  private dashboards = new Map<string, CompositeDashboard>();

  /**
   * Register a MeasurementProvider.
   * Automatically creates/composites the dashboard and object hierarchy.
   */
  registerProvider(provider: MeasurementProvider): void {
    const def = provider.getDashboardDefinition();
    let dashboard = this.dashboards.get(def.id);
    if (!dashboard) {
      dashboard = new CompositeDashboard(def);
      this.dashboards.set(def.id, dashboard);
    }
    dashboard.addProvider(provider);
  }

  /**
   * Register a full Dashboard (will be merged into composite).
   */
  registerDashboard(dashboard: Dashboard): void {
    const def = dashboard.definition;
    let composite = this.dashboards.get(def.id);
    if (!composite) {
      composite = new CompositeDashboard(def);
      this.dashboards.set(def.id, composite);
    }
    composite.addDashboard(dashboard);
  }

  /**
   * Register a simple dashboard definition (backward compat).
   */
  register(definition: DashboardDefinition): void {
    if (!this.dashboards.has(definition.id)) {
      this.dashboards.set(definition.id, new CompositeDashboard(definition));
    }
  }

  unregister(id: string): void {
    this.dashboards.delete(id);
  }

  getDashboard(id: string): Dashboard | undefined {
    return this.dashboards.get(id);
  }

  getDashboards(): Dashboard[] {
    return Array.from(this.dashboards.values());
  }

  /**
   * Get all registered dashboard definitions.
   */
  getDefinitions(): DashboardDefinition[] {
    return Array.from(this.dashboards.values()).map((d) => d.definition);
  }
}
