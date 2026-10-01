import nodemailer, { type SentMessageInfo, type Transporter } from 'nodemailer';

import type { WorkerConfig } from '../config/env.js';
import { buildSmtpMessage } from './message.js';
import {
  AmbiguousDeliveryError,
  DefinitiveDeliveryError,
  SenderConfigurationError,
  type DeliveryInput,
  type DeliveryResult,
  type EmailSender,
} from './types.js';

export interface EtherealAccount {
  email: string;
  password: string;
}

interface MailTransport {
  sendMail(message: ReturnType<typeof buildSmtpMessage>): Promise<SentMessageInfo>;
  close(): void;
}

type TransportFactory = (account: EtherealAccount) => MailTransport;

export function getEtherealAccounts(
  config: Pick<
    WorkerConfig,
    | 'ETHEREAL_SENDER_1_USER'
    | 'ETHEREAL_SENDER_1_PASS'
    | 'ETHEREAL_SENDER_2_USER'
    | 'ETHEREAL_SENDER_2_PASS'
  >,
): EtherealAccount[] {
  return [
    { email: config.ETHEREAL_SENDER_1_USER, password: config.ETHEREAL_SENDER_1_PASS },
    { email: config.ETHEREAL_SENDER_2_USER, password: config.ETHEREAL_SENDER_2_PASS },
  ];
}

export class EtherealEmailSender implements EmailSender {
  readonly #transports = new Map<string, MailTransport>();

  constructor(
    accounts: readonly EtherealAccount[],
    transportFactory: TransportFactory = createEtherealTransport,
  ) {
    const uniqueAddresses = new Set(
      accounts.map((account) => normalizeSenderAddress(account.email)),
    );
    if (uniqueAddresses.size !== accounts.length) {
      throw new Error('Ethereal sender configuration contains duplicate addresses');
    }

    for (const account of accounts) {
      const key = normalizeSenderAddress(account.email);
      this.#transports.set(key, transportFactory(account));
    }
  }

  async send(input: DeliveryInput): Promise<DeliveryResult> {
    const transport = this.#transports.get(normalizeSenderAddress(input.senderEmail));
    if (!transport) throw new SenderConfigurationError();

    try {
      const info = await transport.sendMail(buildSmtpMessage(input));
      const previewUrl = nodemailer.getTestMessageUrl(info);
      return {
        messageId: info.messageId,
        previewUrl: typeof previewUrl === 'string' ? previewUrl : null,
      };
    } catch (error) {
      if (isDefinitiveSmtpRejection(error)) {
        throw new DefinitiveDeliveryError('SMTP permanently rejected the message', error);
      }
      throw new AmbiguousDeliveryError('SMTP delivery outcome is uncertain', error);
    }
  }

  close(): void {
    for (const transport of this.#transports.values()) transport.close();
  }
}

function createEtherealTransport(account: EtherealAccount): Transporter {
  return nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: { user: account.email, pass: account.password },
  });
}

function normalizeSenderAddress(value: string): string {
  return value.trim().toLowerCase();
}

function isDefinitiveSmtpRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('responseCode' in error)) return false;
  const responseCode = Reflect.get(error, 'responseCode');
  return typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600;
}
