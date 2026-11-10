/** Shapes of the server's `/ai/*` endpoints (business values inside the JSON envelope). */
export const AI_MEDIA_KINDS = ['image', 'video', 'audio'] as const;
export type AIMediaKind = (typeof AI_MEDIA_KINDS)[number];

/** Public route segment per kind: `/ai/image`, `/ai/video`, `/ai/music`. */
export const AI_SCENES = [
  { kind: 'image', segment: 'image' },
  { kind: 'video', segment: 'video' },
  { kind: 'audio', segment: 'music' },
] as const satisfies readonly { kind: AIMediaKind; segment: string }[];

export const AI_TASK_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'WAITING_PROVIDER',
  'RETRYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type AITaskStatus = (typeof AI_TASK_STATUSES)[number];
export type AITaskCharge = 'NONE' | 'HELD' | 'CONFIRMED' | 'RELEASED';

export interface AITaskOutput {
  index: number;
  contentType: string;
  bytes: number;
}

export interface AITaskView {
  id: string;
  kind: AIMediaKind;
  providerId: string;
  model: string;
  status: AITaskStatus;
  stage?: string | null;
  progress?: number | null;
  cost: number;
  charge: AITaskCharge;
  prompt: string;
  error: { code: string; summary: string } | null;
  outputs: AITaskOutput[];
  canCancel: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MediaCatalogEntry {
  providerId: string;
  model: string;
  label?: string;
  /** Credits per output; the task costs `cost × count`. */
  cost: number;
  available: boolean;
}
export interface ChatCatalogEntry {
  providerId: string;
  model: string;
  label?: string;
  available: boolean;
}
export interface ChatPricing {
  per1kInputTokens: number;
  per1kOutputTokens: number;
  minimum: number;
}
export interface AICatalog {
  image: MediaCatalogEntry[];
  video: MediaCatalogEntry[];
  audio: MediaCatalogEntry[];
  chat: ChatCatalogEntry[];
  chatPricing: ChatPricing;
}

/** Ticket for one output; `url` is redeemed once at `/api/files/:assetId/download`. */
export interface OutputTicket {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
  contentType: string;
  bytes: number;
}

export interface CursorPage<T> {
  items: T[];
  next: string | null;
}

export type AITaskOptionValue = string | number | boolean | string[];
export interface AITaskSubmit {
  kind: AIMediaKind;
  providerId: string;
  model: string;
  prompt: string;
  options?: Record<string, AITaskOptionValue>;
  references?: string[];
  /** Total credits quoted to the user; the server answers 409 AI_TASK_COST_CHANGED when it differs. */
  cost?: number;
}
