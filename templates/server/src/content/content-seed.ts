import { randomUUID } from 'node:crypto';
import type { StarterDataSeed } from '../accounts/create-administrator';
import { ApplicationTransaction, type ApplicationDatabase } from '../database';
import { loadContentDirectory, type FileEntry, type FileIssue } from './content-files';

export const CONTENT_SEED_ACTOR = 'system:content-seed';
export interface ContentSeedOptions {
  /** Absolute path of the content directory (normally `contentOptionsFromEnvironment(env).contentDirectory`). */
  directory: string;
  /** true: new rows are inserted as published; false (default): as drafts for admins to review. */
  publish?: boolean;
  /** Recorded as createdBy/updatedBy; defaults to CONTENT_SEED_ACTOR. */
  actor?: string;
}
export interface ContentSeedReport {
  created: Array<{ kind: string; locale: string; slug: string; status: 'draft' | 'published' }>;
  /** Already present (same kind/locale/slug, or the address is published by another entry): left untouched. */
  skipped: Array<{ kind: string; locale: string; slug: string }>;
  issues: FileIssue[];
}

/**
 * Copies file-backed documents into the CMS so admins can edit them. Idempotent: an entry that
 * already exists is never modified, so re-running after admin edits changes nothing. Each insert
 * is its own statement; a published insert writes the same projection the publish action does.
 */
export async function seedContentFromFiles(database: Pick<ApplicationDatabase, 'transaction'>, options: ContentSeedOptions): Promise<ContentSeedReport> {
  const { entries, issues } = await loadContentDirectory(options.directory);
  const report: ContentSeedReport = { created: [], skipped: [], issues };
  const actor = options.actor ?? CONTENT_SEED_ACTOR, publish = options.publish === true;
  for (const entry of entries) {
    const inserted = await database.transaction(tx => tx.query<{ id: string }>(publish ? publishedInsert : draftInsert, values(entry, actor, publish)));
    const key = { kind: entry.kind, locale: entry.locale, slug: entry.slug };
    if (inserted.rows[0]) report.created.push({ ...key, status: publish ? 'published' : 'draft' });
    else report.skipped.push(key);
  }
  return report;
}

/**
 * The file seed as a starter-data contribution: runs on administrator setup's transaction, so a failed
 * setup leaves no half-seeded CMS. Invalid files are reported by `content:seed`, never fatal here.
 */
export function contentStarterSeed(options: ContentSeedOptions): StarterDataSeed {
  return { name: 'content', run: async tx => {
    if (!(tx instanceof ApplicationTransaction)) throw new Error('Application transaction is required');
    await seedContentFromFiles({ transaction: work => work(tx) }, options);
  } };
}

// No conflict target: either unique index (kind/locale/slug or kind/locale/publishedSlug) means "already seeded or taken".
const draftInsert = `INSERT INTO site_content_entries ("id","kind","locale","slug","draft","createdBy","updatedBy")
  VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6) ON CONFLICT DO NOTHING RETURNING "id"`;
const publishedInsert = `INSERT INTO site_content_entries ("id","kind","locale","slug","draft","createdBy","updatedBy",
  "status","publishedSlug","published","publishedTitle","publishedDescription","searchText","publishedAt","publishedRevision","revision")
  VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6,'published',$4,$5::jsonb,$7,$8,$9,($10::timestamptz AT TIME ZONE 'UTC'),1,1)
  ON CONFLICT DO NOTHING RETURNING "id"`;
function values(entry: FileEntry, actor: string, publish: boolean): unknown[] {
  const draft = JSON.stringify({ document: entry.document, categoryIds: [] });
  const base = [randomUUID(), entry.kind, entry.locale, entry.slug, draft, actor];
  return publish ? [...base, entry.document.title, entry.document.description, entry.searchText, entry.publishedAt.toISOString()] : base;
}
