-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "homeCity" TEXT NOT NULL DEFAULT '',
    "homeCountry" TEXT NOT NULL DEFAULT 'Kenya',
    "githubUrl" TEXT NOT NULL DEFAULT '',
    "applyThreshold" INTEGER NOT NULL DEFAULT 65,
    "skipThreshold" INTEGER NOT NULL DEFAULT 50,
    "weights" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sourceUrl" TEXT NOT NULL DEFAULT '',
    "applyUrl" TEXT NOT NULL DEFAULT '',
    "posting" TEXT NOT NULL,
    "attachmentName" TEXT,
    "status" TEXT NOT NULL,
    "extraction" JSONB,
    "score" JSONB,
    "draft" JSONB,
    "verification" JSONB,
    "filterReason" TEXT,
    "error" TEXT,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileFact" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "sourceUrl" TEXT,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposedFact" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "source" TEXT,
    "sourceUrl" TEXT,
    "evidence" TEXT,
    "matches" JSONB,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposedFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineQuestion" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "PipelineQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_status_updatedAt_idx" ON "Job"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");

-- CreateIndex
CREATE INDEX "ProfileFact_status_updatedAt_idx" ON "ProfileFact"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ProposedFact_createdAt_idx" ON "ProposedFact"("createdAt");

-- CreateIndex
CREATE INDEX "PipelineQuestion_position_idx" ON "PipelineQuestion"("position");
