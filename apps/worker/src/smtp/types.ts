import type { CampaignAttachment } from '@reachinbox/shared/attachments';

export interface DeliveryInput {
  emailId: string;
  senderName: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  body: string;
  bodyHtml?: string | undefined;
  attachments?: CampaignAttachment[] | undefined;
}

export interface DeliveryResult {
  messageId: string;
  previewUrl: string | null;
}

export interface EmailSender {
  send(input: DeliveryInput): Promise<DeliveryResult>;
  close(): Promise<void> | void;
}

export class SenderConfigurationError extends Error {
  constructor() {
    super('No Ethereal account is configured for this sender');
    this.name = 'SenderConfigurationError';
  }
}

export class DefinitiveDeliveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DefinitiveDeliveryError';
  }
}

export class AmbiguousDeliveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AmbiguousDeliveryError';
  }
}
