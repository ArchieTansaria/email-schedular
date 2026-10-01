export const EMAIL_QUEUE_NAME = 'email-send' as const;
export const SEND_EMAIL_JOB_NAME = 'send-email' as const;

export interface SendEmailJobData {
  emailId: string;
}

export function makeEmailJobId(emailId: string): string {
  return `email-${emailId}`;
}
