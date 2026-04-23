export type AgmoDispatchRequest = {
  request_id: string;
  kind: "inbox" | "mailbox";
  to_worker: string;
  pane_id?: string;
  status: "pending" | "notified" | "delivered" | "failed";
  trigger_message?: string;
  message_id?: string;
  created_at: string;
  notified_at?: string;
  delivered_at?: string;
  failed_at?: string;
  transport_preference:
    | "hook_preferred_with_fallback"
    | "transport_direct";
};
