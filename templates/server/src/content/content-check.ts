import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { loadContentDirectory, type FileIssue } from './content-files';

export interface ContentCheckReport {
  /** Absolute directory that was checked. */
  directory: string;
  /** Files that passed validation. */
  valid: number;
  /** One entry per rejected file, with the dotted field path in the message when known. */
  issues: FileIssue[];
}

/**
 * Validates every file below the content directory exactly as the server does at startup
 * (`loadContentDirectory`: the same names, limits, front matter and `validateSiteDocument`), without a
 * database or network. A missing directory is an issue here, unlike at startup where it means "none".
 */
export async function checkContentDirectory(directory: string, cwd = process.cwd()): Promise<ContentCheckReport> {
  const absolute = isAbsolute(directory) ? directory : resolve(cwd, directory);
  const stat = await realpath(absolute).then(path => lstat(path)).catch(() => null);
  if (!stat?.isDirectory()) return { directory: absolute, valid: 0, issues: [{ source: '.', message: 'Content directory not found' }] };
  const { entries, issues } = await loadContentDirectory(absolute);
  return { directory: absolute, valid: entries.length, issues };
}

/** Human-readable lines: one per issue, then a summary. Never prints file contents. */
export function formatContentCheck(report: ContentCheckReport): string[] {
  return [
    ...report.issues.map(issue => `invalid ${issue.source}: ${issue.message}`),
    `Content check: ${report.valid} valid, ${report.issues.length} invalid (${report.directory}).`,
  ];
}
