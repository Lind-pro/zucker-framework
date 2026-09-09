/**
 * UserAllowPermissionHandler
 *
 * Allows bypassing permission checks for specific users/dimensions
 * based on configuration. Supports AntPath-style pattern matching.
 *
 * Configuration example:
 * ```
 * {
 *   user: { admin: '*', guest: '**.query*' },
 *   role: { admin: '*' }
 * }
 * ```
 *
 * Where keys are dimension type (user/role/etc), nested keys are
 * dimension IDs, and values are glob patterns for allowed controller methods.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Authentication } from '../interfaces';

export interface AllowPermissionConfig {
  /** Map of dimensionType -> dimensionId -> pattern */
  allows: Record<string, Record<string, string>>;
}

/**
 * Simple glob-style path matcher (similar to Spring AntPathMatcher with "." separator).
 * Supports:
 * - `*` matches any single segment
 * - `**` matches any number of segments
 * - Exact text matches literally
 */
function matchPath(pattern: string, path: string): boolean {
  if (pattern === '*') return true;

  const patternParts = pattern.split('.');
  const pathParts = path.split('.');

  let pi = 0;
  let pp = 0;
  let starPi = -1;
  let starPp = -1;

  while (pp < pathParts.length) {
    if (pi < patternParts.length && patternParts[pi] === '**') {
      starPi = pi;
      starPp = pp;
      pi++;
    } else if (
      pi < patternParts.length &&
      (patternParts[pi] === '*' || patternParts[pi] === pathParts[pp])
    ) {
      pi++;
      pp++;
    } else if (starPi >= 0) {
      pi = starPi + 1;
      starPp++;
      pp = starPp;
    } else {
      return false;
    }
  }

  while (pi < patternParts.length && patternParts[pi] === '**') {
    pi++;
  }
  return pi === patternParts.length;
}

@Injectable()
export class UserAllowPermissionHandler {
  private readonly logger = new Logger(UserAllowPermissionHandler.name);
  private config: AllowPermissionConfig = { allows: {} };

  /**
   * Set the allows configuration.
   */
  setConfig(config: AllowPermissionConfig): void {
    this.config = config;
  }

  /**
   * Check if the authentication is allowed to bypass permission checks
   * for the given controller path (className.methodName).
   *
   * @param authentication Current user authentication
   * @param controllerPath Full path like "UserController.query"
   * @returns true if allowed (skip permission check), false otherwise
   */
  isAllowed(authentication: Authentication, controllerPath: string): boolean {
    const { allows } = this.config;
    if (!allows || Object.keys(allows).length === 0) return false;

    for (const [dimensionType, dimensionConfig] of Object.entries(allows)) {
      if (dimensionType === 'user') {
        // Check by user ID
        const userId = authentication.getUser().id;
        const pattern = dimensionConfig[userId];
        if (pattern && matchPath(pattern, controllerPath)) {
          return true;
        }
      } else {
        // Check by dimension (role, department, etc.)
        for (const [dimensionId, pattern] of Object.entries(dimensionConfig)) {
          const dim = authentication.getDimension(dimensionType, dimensionId);
          if (dim && matchPath(pattern, controllerPath)) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
