-- CreateEnum
CREATE TYPE "public"."EmailStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" UUID NOT NULL,
    "googleSub" VARCHAR(255) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Sender" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fromName" VARCHAR(255) NOT NULL,
    "fromEmail" VARCHAR(320) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Sender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Campaign" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "delayMs" INTEGER NOT NULL,
    "hourlyLimit" INTEGER NOT NULL,
    "totalRecipients" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Email" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "recipientEmail" VARCHAR(320) NOT NULL,
    "originalScheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "public"."EmailStatus" NOT NULL DEFAULT 'SCHEDULED',
    "bullJobId" VARCHAR(255) NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "smtpMessageId" VARCHAR(998),
    "previewUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SlackIntegration" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "teamId" VARCHAR(255) NOT NULL,
    "teamName" VARCHAR(255) NOT NULL,
    "channelId" VARCHAR(255) NOT NULL,
    "channelName" VARCHAR(255) NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "webhookUrlEncrypted" TEXT NOT NULL,
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SlackIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "public"."User"("googleSub");

-- CreateIndex
CREATE INDEX "Sender_userId_idx" ON "public"."Sender"("userId");

-- CreateIndex
CREATE INDEX "Campaign_userId_createdAt_idx" ON "public"."Campaign"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_userId_idempotencyKey_key" ON "public"."Campaign"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Email_bullJobId_key" ON "public"."Email"("bullJobId");

-- CreateIndex
CREATE INDEX "Email_userId_status_scheduledAt_idx" ON "public"."Email"("userId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Email_campaignId_idx" ON "public"."Email"("campaignId");

-- CreateIndex
CREATE INDEX "Email_senderId_scheduledAt_idx" ON "public"."Email"("senderId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlackIntegration_userId_key" ON "public"."SlackIntegration"("userId");

-- AddForeignKey
ALTER TABLE "public"."Sender" ADD CONSTRAINT "Sender_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Campaign" ADD CONSTRAINT "Campaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Campaign" ADD CONSTRAINT "Campaign_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "public"."Sender"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Email" ADD CONSTRAINT "Email_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Email" ADD CONSTRAINT "Email_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Email" ADD CONSTRAINT "Email_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "public"."Sender"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SlackIntegration" ADD CONSTRAINT "SlackIntegration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
