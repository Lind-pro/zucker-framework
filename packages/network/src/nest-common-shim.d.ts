declare module '@nestjs/common' {
  export type Provider =
    | (new (...args: unknown[]) => unknown)
    | {
        provide: unknown;
        useClass?: new (...args: unknown[]) => unknown;
        useFactory?: (...args: any[]) => unknown;
        inject?: unknown[];
        useValue?: unknown;
        useExisting?: unknown;
      };

  export interface DynamicModule {
    module: unknown;
    global?: boolean;
    imports?: unknown[];
    providers?: Provider[];
    exports?: unknown[];
  }

  export interface OnModuleDestroy {
    onModuleDestroy(): void | Promise<void>;
  }

  export class Logger {
    constructor(context?: string);
    log(message: unknown, ...optionalParams: unknown[]): void;
    warn(message: unknown, ...optionalParams: unknown[]): void;
    error(message: unknown, ...optionalParams: unknown[]): void;
  }

  export function Module(_metadata?: Record<string, unknown>): ClassDecorator;
  export function Injectable(): ClassDecorator;
}

declare class Buffer extends Uint8Array {
  static from(data: string): Buffer;
  toString(encoding?: string): string;
}
