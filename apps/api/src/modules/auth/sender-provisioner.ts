import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

type SenderPrisma = Pick<PrismaClient, 'sender'>;

export interface ProvisionedUser {
  id: string;
  name: string;
}

export class SenderProvisioner {
  readonly #prisma: SenderPrisma;
  readonly #senderEmails: readonly string[];

  constructor(options: { prisma: SenderPrisma; senderEmails: readonly string[] }) {
    this.#prisma = options.prisma;
    this.#senderEmails = uniqueNormalizedEmails(options.senderEmails);
  }

  async ensureForUser(user: ProvisionedUser): Promise<void> {
    for (const fromEmail of this.#senderEmails) {
      const existing = await this.#prisma.sender.findFirst({
        where: {
          userId: user.id,
          fromEmail: { equals: fromEmail, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (existing) continue;

      await this.#prisma.sender.upsert({
        where: { id: deterministicSenderId(user.id, fromEmail) },
        create: {
          id: deterministicSenderId(user.id, fromEmail),
          userId: user.id,
          fromName: user.name,
          fromEmail,
          active: true,
        },
        update: {},
      });
    }
  }
}

export function deterministicSenderId(userId: string, fromEmail: string): string {
  const bytes = createHash('sha256')
    .update(`${userId}:${fromEmail.trim().toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uniqueNormalizedEmails(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}
