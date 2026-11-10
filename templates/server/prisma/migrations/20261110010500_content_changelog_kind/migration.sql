-- Changelog notes are stored as content kind 'log'. The original site_content migration pins the
-- accepted kinds in a CHECK constraint, so widen it forward-only (existing rows already satisfy it).
ALTER TABLE "site_content_entries" DROP CONSTRAINT "site_content_entries_kind_check";
ALTER TABLE "site_content_entries" ADD CONSTRAINT "site_content_entries_kind_check" CHECK ("kind" IN ('page','post','doc','log'));
