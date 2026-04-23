export type AgmoLeaderAlertDeliveryChannel = "mailbox" | "slack" | "email";

export type AgmoLeaderAlertMailboxDeliveryConfig = {
  enabled: boolean;
};

export type AgmoLeaderAlertSlackDeliveryConfig = {
  enabled: boolean;
  webhook_url?: string;
  username?: string;
  icon_emoji?: string;
};

export type AgmoLeaderAlertEmailDeliveryConfig = {
  enabled: boolean;
  to: string[];
  from?: string;
  sendmail_path?: string;
  subject_prefix?: string;
};

export type AgmoLeaderAlertDeliveryState = {
  updated_at: string;
  mailbox: AgmoLeaderAlertMailboxDeliveryConfig;
  slack: AgmoLeaderAlertSlackDeliveryConfig;
  email: AgmoLeaderAlertEmailDeliveryConfig;
};

export type AgmoLeaderAlertDeliveryAttempt = {
  delivery_id: string;
  alert_id: string;
  worker_name: string;
  kind: string;
  severity: string;
  channel: AgmoLeaderAlertDeliveryChannel;
  status: "delivered" | "failed" | "skipped";
  attempted_at: string;
  target?: string;
  detail?: string;
  error?: string;
};

export type AgmoLeaderAlertDeliveryLog = {
  updated_at: string;
  attempts: AgmoLeaderAlertDeliveryAttempt[];
};
