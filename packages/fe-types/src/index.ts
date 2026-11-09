/** Represents an authenticated user in the system. */
export interface User {
  /** Unique user identifier. */
  id: string;
  /** Login username. */
  username: string;
  /** Display name. */
  name?: string;
  /** Email address. */
  email?: string;
  /** Whether the user account is active. */
  status?: boolean;
  /** Role codes assigned to the user. */
  roles?: string[];
  /** Permission codes granted to the user. */
  permissions?: string[];
  /** URL to the user's avatar image. */
  avatar?: string;
  /** Preferred locale/language code (e.g. "zh-CN"). */
  locale?: string;
  /** ISO timestamp of account creation. */
  createTime?: string;
}

/** Paginated list response envelope. */
export interface PaginatedResponse<T> {
  /** Items for the current page. */
  data: T[];
  /** Total number of items across all pages. */
  total: number;
  /** Current page number (1-indexed). */
  page: number;
  /** Number of items per page. */
  pageSize: number;
  /** Total number of pages. */
  totalPages: number;
}

/** Standard API response envelope wrapping a typed result. */
export interface ApiResponse<T> {
  /** Business status code (e.g. 200 for success). */
  status: number;
  /** Human-readable response message. */
  message: string;
  /** The response payload. */
  result: T;
  /** ISO timestamp of when the response was generated. */
  timestamp: string;
}

/** Generic tree node used for hierarchical data structures. */
export interface TreeNode {
  /** Unique node identifier. */
  id: string;
  /** Parent node identifier, null for root nodes. */
  parentId?: string | null;
  /** Display name of the node. */
  name: string;
  /** Child nodes in the hierarchy. */
  children?: TreeNode[];
  /** Allow additional domain-specific properties. */
  [key: string]: unknown;
}

/** Option item for select/dropdown components. */
export interface SelectOption {
  /** Display text shown to the user. */
  label: string;
  /** Underlying option value. */
  value: string | number;
  /** Whether this option is selectable. */
  disabled?: boolean;
  /** Nested child options for cascading selects. */
  children?: SelectOption[];
}

/** Navigation menu item with optional permission gating. */
export interface MenuItem {
  /** Unique menu item identifier. */
  id: string;
  /** Display name of the menu entry. */
  name: string;
  /** Route path this menu item links to. */
  path?: string;
  /** Icon identifier or component name. */
  icon?: string;
  /** Parent menu item identifier, null for top-level items. */
  parentId?: string | null;
  /** Numeric sort order for display ordering. */
  sortOrder?: number;
  /** Permission codes required to view this menu item. */
  permissions?: string[];
  /** Nested child menu items. */
  children?: MenuItem[];
}

/** Metadata for a dictionary/enum entry used in forms and displays. */
export interface DictionaryItem {
  /** Unique dictionary item identifier. */
  id: string;
  /** Human-readable display label. */
  label: string;
  /** Machine-readable value. */
  value: string;
  /** Numeric sort order for display ordering. */
  sortOrder?: number;
}

/** Metadata for an uploaded file resource. */
export interface UploadFile {
  /** Unique file identifier. */
  id: string;
  /** Original file name. */
  name: string;
  /** Accessible URL for the file. */
  url: string;
  /** File size in bytes. */
  size: number;
  /** MIME type (e.g. "image/png"). */
  mimeType: string;
  /** ISO timestamp of when the file was uploaded. */
  createdAt: string;
}

// ─── Zod Schemas (runtime validation + type inference) ───────────────
export * from './schemas';

/** Shape of the authentication state managed by the auth store. */
export interface AuthState {
  /** Whether the user is currently authenticated. */
  isAuthenticated: boolean;
  /** Current access token, null when not authenticated. */
  token: string | null;
  /** Current refresh token, null when not available. */
  refreshToken: string | null;
  /** Authenticated user profile, null when not authenticated. */
  user: User | null;
  /** Flat list of permission codes granted to the user. */
  permissions: string[];
}

export { TEMPLATE_VARIABLE_REGEX, extractTemplateVariables } from './template-variables';

export { redactFields } from './redact-fields';

export { inspectUserAgent, type UserAgentDetails } from '@zucker-framework/core/user-agent';

// Back-office wire contract (also available without zod at `@zucker-framework/fe-types/back-office`).
export {
  PORT_ERROR_REASONS,
  PORT_ERROR_STATUS,
  PORT_ERROR,
  brandPortError,
  isPortError,
  isPortErrorReason,
  readPortError,
  PLAN_PRICE_INTERVALS,
  RECURRING_PLAN_PRICE_INTERVALS,
  USER_SUBSCRIPTION_STATUSES,
  USER_SUBSCRIPTION_CYCLES,
  USER_SUBSCRIPTION_SOURCES,
  USER_SUBSCRIPTION_ACTIVITY,
  CYCLE_FOR_INTERVAL,
  QUOTA_RESERVATION_STATES,
} from './back-office';
export type {
  PortErrorReason,
  PortErrorShape,
  PortErrorBody,
  PortErrorView,
  BackOfficePage,
  EntitlementPeriod,
  EntitlementCategory,
  EntitlementCatalogFeature,
  EntitlementCatalogCounter,
  EntitlementCatalogResponse,
  QuotaSnapshot,
  PlanSummary,
  EntitlementsMe,
  PlanPriceInterval,
  PlanPrice,
  SubscriptionPlan,
  SubscriptionPlanWriteBody,
  PublicPlanPrice,
  PublicPlan,
  UserSubscriptionStatus,
  UserSubscriptionCycle,
  UserSubscriptionSource,
  UserSubscriptionActivity,
  UserSubscriptionRow,
  UserSubscriptionDetail,
  UserSubscriptionAssignmentBody,
  PendingPaymentDetails,
  QuotaReservationStatus,
  QuotaUsageRow,
  QuotaReservationRow,
  QuotaReservationActionResult,
  MailLogRow,
} from './back-office';
