export function describeDispatchContract(): Record<string, unknown> {
  return {
    status: "todo",
    flow: [
      "persist inbox/mailbox payload",
      "enqueue dispatch request",
      "notify via hook-preferred transport",
      "fallback to tmux send-keys if needed",
      "mark notified/delivered in durable state"
    ]
  };
}
