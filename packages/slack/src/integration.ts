import type { PrismaClient } from '@prisma/client';

import type { SlackClient, SlackInstallation } from './client.js';
import type { SecretCipher } from './encryption.js';

export class SlackNotConnectedError extends Error {
  constructor() {
    super('Slack is not connected');
    this.name = 'SlackNotConnectedError';
  }
}

export class SlackIntegrationService {
  readonly #prisma: PrismaClient;
  readonly #cipher: SecretCipher;
  readonly #client: SlackClient;

  constructor(options: { prisma: PrismaClient; cipher: SecretCipher; client: SlackClient }) {
    this.#prisma = options.prisma;
    this.#cipher = options.cipher;
    this.#client = options.client;
  }

  async status(userId: string) {
    const integration = await this.#prisma.slackIntegration.findUnique({
      where: { userId },
      select: { teamName: true, channelName: true, connectedAt: true },
    });
    return integration
      ? { connected: true as const, ...integration }
      : { connected: false as const };
  }

  async install(userId: string, installation: SlackInstallation) {
    return this.#prisma.slackIntegration.upsert({
      where: { userId },
      create: {
        userId,
        teamId: installation.teamId,
        teamName: installation.teamName,
        channelId: installation.channelId,
        channelName: installation.channelName,
        accessTokenEncrypted: this.#cipher.encrypt(installation.accessToken),
        webhookUrlEncrypted: this.#cipher.encrypt(installation.webhookUrl),
      },
      update: {
        teamId: installation.teamId,
        teamName: installation.teamName,
        channelId: installation.channelId,
        channelName: installation.channelName,
        accessTokenEncrypted: this.#cipher.encrypt(installation.accessToken),
        webhookUrlEncrypted: this.#cipher.encrypt(installation.webhookUrl),
        connectedAt: new Date(),
      },
      select: { teamName: true, channelName: true, connectedAt: true },
    });
  }

  async disconnect(userId: string): Promise<void> {
    const integration = await this.#prisma.slackIntegration.findUnique({ where: { userId } });
    if (!integration) return;
    const token = this.#cipher.decrypt(integration.accessTokenEncrypted);
    await this.#client.revokeToken(token);
    await this.#prisma.slackIntegration.delete({ where: { userId } });
  }

  async sendTest(userId: string): Promise<void> {
    const integration = await this.#prisma.slackIntegration.findUnique({ where: { userId } });
    if (!integration) throw new SlackNotConnectedError();
    await this.#client.postWebhook(
      this.#cipher.decrypt(integration.webhookUrlEncrypted),
      'ReachInbox Slack integration test succeeded.',
    );
  }
}
