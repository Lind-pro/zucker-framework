import type { CaptureContext } from './types';
export declare const CAPTURE_LIMITS: Readonly<{ maxEdgeDevicePx: number; maxDevicePixels: number }>;
export declare function captureFits(width: number, height: number, dpr: number): boolean;
export declare function assertCaptureFits(width: number, height: number, dpr: number, message: string): void;
export declare function captureBudget(dpr: number): { maxEdge: number; maxArea: number };
export declare function readDevicePixelRatio(ctx: CaptureContext): Promise<number>;
