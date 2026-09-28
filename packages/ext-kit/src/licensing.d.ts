import type { Licensing, LicensingConfig } from './types';
export type { Entitlement, Licensing } from './types';
export declare function createLicensing(namespace: string, brand: string, config: LicensingConfig): Licensing;
