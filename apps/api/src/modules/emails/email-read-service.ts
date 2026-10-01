import { EmailStatus, Prisma, type PrismaClient } from '@prisma/client';
import type {
  EmailDetailResponse,
  EmailLifecycleStatus,
  EmailListItem,
  EmailListResponse,
} from '@reachinbox/shared/contracts';
import { z } from 'zod';

const cursorSchema = z.object({
  timestamp: z.iso.datetime(),
  id: z.uuid(),
});

const emailListSelect = Prisma.validator<Prisma.EmailSelect>()({
  id: true,
  campaignId: true,
  recipientEmail: true,
  status: true,
  scheduledAt: true,
  sentAt: true,
  failureReason: true,
  updatedAt: true,
  campaign: { select: { subject: true, body: true } },
  sender: { select: { id: true, fromName: true, fromEmail: true } },
});

const emailDetailSelect = Prisma.validator<Prisma.EmailSelect>()({
  id: true,
  campaignId: true,
  recipientEmail: true,
  status: true,
  originalScheduledAt: true,
  scheduledAt: true,
  sentAt: true,
  failureReason: true,
  campaign: { select: { subject: true, body: true } },
  sender: { select: { id: true, fromName: true, fromEmail: true } },
});

type EmailListRow = Prisma.EmailGetPayload<{ select: typeof emailListSelect }>;

export class InvalidEmailCursorError extends Error {
  constructor() {
    super('cursor is invalid');
    this.name = 'InvalidEmailCursorError';
  }
}

export class EmailReadService {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async listScheduled(input: {
    userId: string;
    limit: number;
    cursor?: string | undefined;
  }): Promise<EmailListResponse> {
    const statuses = [EmailStatus.SCHEDULED, EmailStatus.PROCESSING];
    const cursor = decodeCursor(input.cursor);
    const where: Prisma.EmailWhereInput = {
      userId: input.userId,
      status: { in: statuses },
      ...(cursor
        ? {
            OR: [
              { scheduledAt: { gt: new Date(cursor.timestamp) } },
              { scheduledAt: new Date(cursor.timestamp), id: { gt: cursor.id } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.#prisma.email.count({ where: { userId: input.userId, status: { in: statuses } } }),
      this.#prisma.email.findMany({
        where,
        select: emailListSelect,
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
        take: input.limit + 1,
      }),
    ]);
    return pageResult(rows, input.limit, total, (row) => row.scheduledAt);
  }

  async listSent(input: {
    userId: string;
    limit: number;
    cursor?: string | undefined;
  }): Promise<EmailListResponse> {
    const statuses = [EmailStatus.SENT, EmailStatus.FAILED];
    const cursor = decodeCursor(input.cursor);
    const where: Prisma.EmailWhereInput = {
      userId: input.userId,
      status: { in: statuses },
      ...(cursor
        ? {
            OR: [
              { updatedAt: { lt: new Date(cursor.timestamp) } },
              { updatedAt: new Date(cursor.timestamp), id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.#prisma.email.count({ where: { userId: input.userId, status: { in: statuses } } }),
      this.#prisma.email.findMany({
        where,
        select: emailListSelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      }),
    ]);
    return pageResult(rows, input.limit, total, (row) => row.updatedAt);
  }

  async findDetail(userId: string, emailId: string): Promise<EmailDetailResponse | null> {
    const email = await this.#prisma.email.findFirst({
      where: { id: emailId, userId },
      select: emailDetailSelect,
    });
    if (!email) return null;
    return {
      id: email.id,
      campaignId: email.campaignId,
      recipientEmail: email.recipientEmail,
      subject: email.campaign.subject,
      body: email.campaign.body,
      status: email.status as EmailLifecycleStatus,
      originalScheduledAt: email.originalScheduledAt.toISOString(),
      scheduledAt: email.scheduledAt.toISOString(),
      sentAt: email.sentAt?.toISOString() ?? null,
      failureReason: email.failureReason,
      sender: email.sender,
    };
  }
}

function pageResult(
  rows: EmailListRow[],
  limit: number,
  total: number,
  timestamp: (row: EmailListRow) => Date,
): EmailListResponse {
  const hasNextPage = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  const last = visibleRows.at(-1);
  return {
    items: visibleRows.map(toListItem),
    total,
    nextCursor:
      hasNextPage && last
        ? encodeCursor({ timestamp: timestamp(last).toISOString(), id: last.id })
        : null,
  };
}

function toListItem(email: EmailListRow): EmailListItem {
  return {
    id: email.id,
    campaignId: email.campaignId,
    recipientEmail: email.recipientEmail,
    subject: email.campaign.subject,
    bodyPreview: preview(email.campaign.body),
    status: email.status as EmailLifecycleStatus,
    scheduledAt: email.scheduledAt.toISOString(),
    sentAt: email.sentAt?.toISOString() ?? null,
    failureReason: email.failureReason,
    sender: email.sender,
  };
}

function preview(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 160 ? collapsed : `${collapsed.slice(0, 157)}...`;
}

function encodeCursor(value: { timestamp: string; id: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): z.infer<typeof cursorSchema> | undefined {
  if (!value) return undefined;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Converted to the stable public validation error below.
  }
  throw new InvalidEmailCursorError();
}
