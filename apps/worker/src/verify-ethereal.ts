import { randomUUID } from 'node:crypto';

import { parseWorkerConfig } from './config/env.js';
import { loadRootEnvironment } from './config/load-env.js';
import { EtherealEmailSender, getEtherealAccounts } from './smtp/ethereal-email-sender.js';

loadRootEnvironment();

const config = parseWorkerConfig(process.env);
const accounts = getEtherealAccounts(config);
const sender = new EtherealEmailSender(accounts);

try {
  for (const account of accounts) {
    const emailId = randomUUID();
    const result = await sender.send({
      emailId,
      senderName: 'ReachInbox Ethereal Verification',
      senderEmail: account.email,
      recipientEmail: account.email,
      subject: `ReachInbox Ethereal verification ${emailId}`,
      body: 'This message verifies the configured Ethereal SMTP account.',
    });
    process.stdout.write(
      `${account.email}: messageId=${result.messageId} previewUrl=${result.previewUrl ?? 'unavailable'}\n`,
    );
  }
} finally {
  sender.close();
}
