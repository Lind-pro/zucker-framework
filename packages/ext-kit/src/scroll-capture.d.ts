import type { CaptureContext } from './types';
export declare function prepare(ctx: CaptureContext, waitForContent?: () => Promise<void>): Promise<void>;
export declare function restore(ctx: CaptureContext): Promise<void>;
