/**
 * Zod Schemas — 前后端共享的 Single Source of Truth
 *
 * 对标 Claude Code 的 Tool inputSchema/outputSchema 模式：
 * 一个定义同时提供运行时验证和 TypeScript 类型推断。
 *
 * 用法:
 * ```ts
 * // 后端 — DTO 验证
 * const data = UserSchema.parse(req.body);
 *
 * // 前端 — 表单验证
 * const result = UserSchema.safeParse(formValues);
 *
 * // 类型推断（无需手动维护 interface）
 * type User = z.infer<typeof UserSchema>;
 * ```
 */
import { z } from 'zod/v4';

// ─── User ────────────────────────────────────────────────────────────

export const UserSchema = z.object({
  id: z.string(),
  username: z.string().min(2).max(32),
  name: z.string().optional(),
  email: z.string().email().optional(),
  status: z.boolean().optional(),
  roles: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  avatar: z.string().url().optional(),
  locale: z.string().optional(),
  createTime: z.string().optional(),
});

export const CreateUserSchema = UserSchema.omit({ id: true, createTime: true }).extend({
  password: z.string().min(6).max(128),
});

export const UpdateUserSchema = UserSchema.partial().required({ id: true });

// ─── Paginated Response ──────────────────────────────────────────────

export const PaginatedResponseSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    data: z.array(itemSchema),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    totalPages: z.number().int().min(0),
  });

// ─── API Response ────────────────────────────────────────────────────

export const ApiResponseSchema = <T extends z.ZodType>(resultSchema: T) =>
  z.object({
    status: z.number().int(),
    message: z.string(),
    result: resultSchema,
    timestamp: z.union([z.string(), z.number()]),
  });

export const ApiErrorResponseSchema = z.object({
  status: z.number().int(),
  code: z.string(),
  message: z.string(),
  result: z.unknown().nullable(),
  timestamp: z.union([z.string(), z.number()]),
});

// ─── Tree Node ───────────────────────────────────���───────────────────

export const TreeNodeSchema: z.ZodType<{
  id: string;
  name: string;
  parentId?: string | null;
  children?: Array<{ id: string; name: string; parentId?: string | null; children?: unknown[] }>;
}> = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable().optional(),
  children: z.lazy(() => z.array(TreeNodeSchema)).optional(),
});

// ─── Select Option ───────────────────────────────────────────────────

export const SelectOptionSchema: z.ZodType<{
  label: string;
  value: string | number;
  disabled?: boolean;
  children?: Array<{ label: string; value: string | number; disabled?: boolean; children?: unknown[] }>;
}> = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  disabled: z.boolean().optional(),
  children: z.lazy(() => z.array(SelectOptionSchema)).optional(),
});

// ─── Menu Item ───────────────────────────────────────────────────────

export const MenuItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string().optional(),
  icon: z.string().optional(),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  permissions: z.array(z.string()).optional(),
  children: z.lazy((): z.ZodType => z.array(MenuItemSchema)).optional(),
});

// ─── Dictionary Item ─────────────────────────────────────────────────

export const DictionaryItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  sortOrder: z.number().int().optional(),
});

// ─── Upload File ─────────────────────────────────────────────────────

export const UploadFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  size: z.number().int().min(0),
  mimeType: z.string(),
  createdAt: z.string(),
});

// ─── Auth State ──────────────────────────────────────────────────────

export const AuthStateSchema = z.object({
  isAuthenticated: z.boolean(),
  token: z.string().nullable(),
  refreshToken: z.string().nullable(),
  user: UserSchema.nullable(),
  permissions: z.array(z.string()),
});

// ─── Login Request/Response ──────────────────────────────────────────

export const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  verifyCode: z.string().optional(),
});

export const LoginResponseSchema = z.object({
  token: z.string(),
  refreshToken: z.string().optional(),
  user: UserSchema,
});
