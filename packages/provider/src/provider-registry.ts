import { Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@zucker-framework/core';

/**
 * A named provider instance with optional metadata.
 * @template T - The type of the provided instance
 */
export interface Provider<T> {
  /** Unique identifier for this provider */
  id: string;
  /** The provider instance */
  instance: T;
  /** Optional metadata associated with this provider */
  metadata?: Record<string, unknown>;
}

/**
 * Disposable handle returned by register — call dispose() to unregister.
 * Mirrors Java Reactor Disposable pattern used in jetlinks Provider.
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Registry for managing named provider instances.
 * Supports registration, lookup, default provider, and register-if-absent patterns.
 * @template T - The type of the provided instances
 */
export interface ProviderRegistry<T> {
  /** Register a provider; returns a Disposable to unregister it later. */
  register(provider: Provider<T>): Disposable;
  unregister(id: string): void;
  get(id: string): Provider<T> | undefined;
  /** Get provider by id; throws if not found. Mirrors Java Provider.getNow(). */
  getNow(id: string): Provider<T>;
  getAll(): Provider<T>[];
  getDefault(): Provider<T> | undefined;
  setDefault(id: string): void;
  /**
   * Register if absent — returns the existing provider if one is already
   * registered under the same id, otherwise registers and returns undefined.
   * Mirrors Java Provider.registerIfAbsent().
   */
  registerIfAbsent(provider: Provider<T>): Provider<T> | undefined;
  /**
   * Register if absent with a builder function.
   * Mirrors Java Provider.registerIfAbsent(id, Function).
   */
  registerIfAbsentWith(id: string, builder: (id: string) => Provider<T>): Provider<T> | undefined;
}

@Injectable()
export class DefaultProviderRegistry<T> implements ProviderRegistry<T> {
  private readonly logger = new Logger(DefaultProviderRegistry.name);
  private providers = new Map<string, Provider<T>>();
  private registrations = new Map<string, symbol>();
  private defaultId: string | null = null;
  private hooks: RegistryHook<T>[] = [];

  register(provider: Provider<T>): Disposable {
    const id = provider.id;
    const registration = Symbol(id);
    this.registrations.set(id, registration);
    this.providers.set(id, provider);
    this.hooks.forEach((h) => h.onRegister?.(provider));
    this.logger.log(`Provider registered: ${provider.id}`);
    if (this.providers.size === 1) {
      this.defaultId = provider.id;
    }
    return { dispose: () => {
      if (this.registrations.get(id) === registration) this.unregister(id);
    } };
  }

  unregister(id: string): void {
    const provider = this.providers.get(id);
    if (provider) {
      this.providers.delete(id);
      this.registrations.delete(id);
      this.hooks.forEach((h) => h.onUnregister?.(provider));
      this.logger.log(`Provider unregistered: ${id}`);
      if (this.defaultId === id) {
        this.defaultId = this.providers.size > 0
          ? this.providers.keys().next().value ?? null
          : null;
      }
    }
  }

  get(id: string): Provider<T> | undefined {
    return this.providers.get(id);
  }

  /**
   * Get provider by id; throws if not found.
   * Mirrors Java SimpleProvider.getNow() which throws BusinessException.
   */
  getNow(id: string): Provider<T> {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new NotFoundException(`Unsupported provider: ${id}`);
    }
    return provider;
  }

  getAll(): Provider<T>[] {
    return Array.from(this.providers.values());
  }

  getDefault(): Provider<T> | undefined {
    return this.defaultId ? this.providers.get(this.defaultId) : undefined;
  }

  setDefault(id: string): void {
    if (!this.providers.has(id)) {
      throw new NotFoundException(`Provider not found: ${id}`);
    }
    this.defaultId = id;
  }

  /**
   * Register if absent — if a provider with the same id already exists,
   * returns the old provider and skips registration. Otherwise registers
   * the new provider and returns undefined.
   * Mirrors Java SimpleProvider.registerIfAbsent(id, T).
   */
  registerIfAbsent(provider: Provider<T>): Provider<T> | undefined {
    const existing = this.providers.get(provider.id);
    if (existing) {
      return existing;
    }
    this.register(provider);
    return undefined;
  }

  /**
   * Register if absent using a builder function.
   * Mirrors Java SimpleProvider.registerIfAbsent(id, Function<String, T>).
   */
  registerIfAbsentWith(id: string, builder: (id: string) => Provider<T>): Provider<T> | undefined {
    const existing = this.providers.get(id);
    if (existing) {
      return existing;
    }
    const provider = builder(id);
    this.register(provider);
    return undefined;
  }

  addHook(hook: RegistryHook<T>): Disposable {
    this.hooks.push(hook);
    return { dispose: () => this.removeHook(hook) };
  }

  removeHook(hook: RegistryHook<T>): void {
    const idx = this.hooks.indexOf(hook);
    if (idx >= 0) this.hooks.splice(idx, 1);
  }
}

/**
 * Lifecycle hook for ProviderRegistry events.
 * Allows reacting to provider registration and unregistration.
 * @template T - The type of the provided instances
 */
export interface RegistryHook<T> {
  /** Called when a new provider is registered */
  onRegister?(provider: Provider<T>): void;
  /** Called when a provider is unregistered */
  onUnregister?(provider: Provider<T>): void;
}
