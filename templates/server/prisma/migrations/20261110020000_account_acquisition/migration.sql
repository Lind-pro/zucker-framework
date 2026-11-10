-- Sign-up acquisition side table (accounts-extra.prisma). Additive only; existing rows are untouched.
CREATE TABLE "user_acquisition" (
    "userId" TEXT NOT NULL,
    "signupMethod" VARCHAR(32) NOT NULL,
    "signupIp" VARCHAR(45),
    "signupUtmSource" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_acquisition_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "user_acquisition_signupUtmSource_createdAt_idx" ON "user_acquisition"("signupUtmSource", "createdAt");
CREATE INDEX "user_acquisition_createdAt_idx" ON "user_acquisition"("createdAt");
