-- WP 4.1a: encrypted archive of every saved connection profile revision (models/connection-revisions.prisma).
-- Existing saved profiles are archived by the application at start-up under the profile lock.
CREATE TABLE "connection_profile_revisions" (
    "profileId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "connection_profile_revisions_pkey" PRIMARY KEY ("profileId", "revision"),
    CONSTRAINT "connection_profile_revisions_profile_check" CHECK ("profileId" ~ '^[a-z][a-z0-9-]{0,62}$'),
    CONSTRAINT "connection_profile_revisions_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "connection_profile_revisions_ciphertext_check" CHECK (char_length("ciphertext") BETWEEN 1 AND 1048576)
);
