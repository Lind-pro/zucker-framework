import type { HostResolver } from '@zucker-framework/core';
import type { MediaModelInfo, MediaType } from '../media.interface';

/**
 * Request parameters the generic adapter can forward. Each one is sent only when the adapter
 * configuration maps it to a body field (`submit.fields`); `prompt` and `model` default to the
 * fields `prompt` and `model`.
 */
export type HttpAsyncTaskRequestParam =
  | 'prompt'
  | 'model'
  | 'negativePrompt'
  | 'width'
  | 'height'
  | 'format'
  | 'count'
  | 'seed'
  | 'steps'
  | 'cfgScale'
  | 'quality'
  | 'style'
  | 'referenceImageUrl'
  | 'referenceImageUrls'
  | 'imageStrength'
  | 'duration'
  | 'fps'
  | 'resolution'
  | 'firstFrameUrl'
  | 'lastFrameUrl'
  | 'cameraMotion'
  | 'lyrics'
  | 'instrumental'
  | 'voice'
  | 'audioTags'
  | 'callbackUrl'
  | 'clientRequestId';

/** How the API key (`MediaGenerationConfig.apiKey`) is sent. Default `{ type: 'bearer' }`. */
export type HttpAsyncTaskAuth =
  | { type: 'bearer' }
  /** The raw key in a named header, e.g. `x-api-key`. */
  | { type: 'header'; name: string }
  | { type: 'none' };

/**
 * Vendor-neutral description of a "submit, then poll" media API. All values are data, so the
 * configuration can come from an operator-managed connection profile.
 *
 * Field paths are dotted property paths into the JSON response (`data.task.id`,
 * `output.0.url`); numeric segments index arrays. Only own properties are read.
 */
export interface HttpAsyncTaskAdapterConfig {
  /** Provider id (`MediaProvider.id`), e.g. `acme-music`. */
  id: string;
  /** Display name. Default: `id`. */
  name?: string;
  /** The single media kind this endpoint produces. */
  mediaType: MediaType;
  /** Models offered; each `mediaType` must equal the adapter's. At least one. */
  models: MediaModelInfo[];
  /**
   * API origin plus optional path prefix. Must be `https:`, carry no credentials, no IP literal or
   * localhost, and use an allowed port. Every request stays on this host and is sent through
   * core's `createPublicFetch` (public-address DNS check, pinned connection, no redirects).
   */
  baseUrl: string;
  /** Ports allowed for `baseUrl`. Default `[443]`. */
  allowedPorts?: readonly number[];
  auth?: HttpAsyncTaskAuth;
  /** Extra static, non-secret request headers. */
  headers?: Readonly<Record<string, string>>;
  submit: {
    /** Path relative to `baseUrl`, starting with `/` (query allowed). */
    path: string;
    /** Default `POST`. */
    method?: 'POST' | 'PUT';
    /** Static JSON fields merged into every submit body before mapped params. */
    body?: Readonly<Record<string, unknown>>;
    /** Param → dotted body field. `prompt`/`model` default to `prompt`/`model`; others are sent only when mapped. */
    fields?: Partial<Record<HttpAsyncTaskRequestParam, string>>;
    /** Path of the provider task id in the submit response. */
    taskIdPath: string;
  };
  poll: {
    /** Path relative to `baseUrl` with a `{taskId}` placeholder (URL-encoded on substitution). */
    path: string;
    /** Default `GET`. */
    method?: 'GET' | 'POST';
    /** Path of the status value. If it is present in the submit response, that response is parsed too. */
    statusPath: string;
    /**
     * Provider status values (compared as strings). Any value outside these lists maps to FAILED
     * with an "unknown status" error, so a misconfigured adapter does not poll forever.
     */
    status: {
      pending?: readonly string[];
      processing?: readonly string[];
      completed: readonly string[];
      failed: readonly string[];
    };
    /** Path to the output: a URL string, an array of URL strings, or an array of objects (see `outputItemUrlField`). */
    outputPath: string;
    /** When `outputPath` is an array of objects: dotted field of each item holding the URL. */
    outputItemUrlField?: string;
    /** Path of a progress number. */
    progressPath?: string;
    /** Value of `progressPath` meaning 100%. Default 100 (use 1 for fractions). */
    progressScale?: number;
    /** Path of a failure message. */
    errorPath?: string;
  };
  /** Reported cost per completed task (USD, observability only). Default 0. */
  costPerTask?: number;
  /** Largest accepted response body. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Explicit vendor-supported count limit (default 1); values above 1 require a mapped count field. */
  maxOutputs?: number;
  /** Explicit vendor-supported reference limit (default inferred from singular/frame field mappings). */
  maxReferences?: number;
}

/** Transport overrides, mainly for tests. */
export interface HttpAsyncTaskTransport {
  /**
   * Replaces the default `createPublicFetch` transport. Host/protocol/credential checks on the
   * URL still run; the public-address DNS check and pinning are then the caller's responsibility.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Resolver for the default transport (tests inject a fake DNS). Ignored when `fetch` is set. */
  resolve?: HostResolver;
}

/** Options for {@link HttpAsyncTaskMediaProvider.createCallbackVerifier} (HMAC over the raw body). */
export interface HttpAsyncTaskCallbackVerifierOptions {
  /** Shared signing secret (at least 16 bytes). */
  secret: string;
  /** Header carrying the signature, e.g. `x-signature`. */
  signatureHeader: string;
  /** Default `sha256`. */
  algorithm?: 'sha256' | 'sha512';
  /** Signature encoding. Default `hex`. */
  encoding?: 'hex' | 'base64';
  /** Prefix stripped from the header value before decoding, e.g. `sha256=`. */
  signaturePrefix?: string;
  /**
   * Header carrying a unix timestamp (seconds). When set, the signed payload is
   * `${timestamp}.${rawBody}` and stale timestamps are refused.
   */
  timestampHeader?: string;
  /** Accepted clock skew/age for `timestampHeader`. Default 300 seconds. */
  toleranceSeconds?: number;
  /** Path of the task id in the callback body. Default: the adapter's `submit.taskIdPath`. */
  taskIdPath?: string;
  /** Map the authenticated body with the adapter's poll mapping into `task`. Default true. */
  parseTask?: boolean;
  /** Clock for tests (ms). */
  now?: () => number;
}
