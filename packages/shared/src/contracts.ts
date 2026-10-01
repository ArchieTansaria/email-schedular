export const SERVICE_NAME = 'reachinbox-scheduler' as const;

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
}

export function createHealthResponse(): HealthResponse {
  return {
    status: 'ok',
    service: SERVICE_NAME,
  };
}

export type EmailLifecycleStatus = 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface CurrentUserResponse {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface SenderSummary {
  id: string;
  fromName: string;
  fromEmail: string;
  active: true;
}

export interface SenderListResponse {
  items: SenderSummary[];
}

export interface EmailSenderSummary {
  id: string;
  fromName: string;
  fromEmail: string;
}

export interface EmailListItem {
  id: string;
  campaignId: string;
  recipientEmail: string;
  subject: string;
  bodyPreview: string;
  status: EmailLifecycleStatus;
  scheduledAt: string;
  sentAt: string | null;
  failureReason: string | null;
  sender: EmailSenderSummary;
}

export interface EmailListResponse {
  items: EmailListItem[];
  total: number;
  nextCursor: string | null;
}

export interface EmailDetailResponse {
  id: string;
  campaignId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  status: EmailLifecycleStatus;
  originalScheduledAt: string;
  scheduledAt: string;
  sentAt: string | null;
  failureReason: string | null;
  sender: EmailSenderSummary;
}

export interface ScheduleCampaignResponse {
  campaignId: string;
  totalRecipients: number;
  startAt: string;
  firstScheduledAt: string;
  lastScheduledAt: string;
}

export type SlackStatusResponse =
  | { connected: false }
  | {
      connected: true;
      teamName: string;
      channelName: string;
      connectedAt: string;
    };

export interface EmailSearchItem {
  emailId: string;
  campaignId: string;
  senderId: string;
  recipientEmail: string;
  senderEmail: string;
  subject: string;
  body: string;
  status: EmailLifecycleStatus;
  originalScheduledAt: string;
  scheduledAt: string;
  sentAt: string | null;
  failureReason: string | null;
}

export interface EmailSearchResponse {
  items: EmailSearchItem[];
  total: number;
  page: number;
  limit: number;
}
