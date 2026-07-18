// SSE hub: a one-way pub/sub pushing granular typed events (full session, a patch, a removal, a
// job update) instead of a bare "something changed, refetch everything" nudge. fsWatcher.ts
// broadcasts; routes/events.ts subscribes.
export type PushEvent =
  | { type: "session"; session: unknown }
  | { type: "session-removed"; id: string }
  | { type: "session-patch"; id: string; patch: Record<string, unknown> }
  | { type: "quickprompt"; job: unknown }
  | { type: "quickprompt-removed"; id: string };

type Client = { write: (chunk: string) => void };

const clients = new Set<Client>();

export function subscribe(client: Client): void {
  clients.add(client);
}

export function unsubscribe(client: Client): void {
  clients.delete(client);
}

export function broadcast(event: PushEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      // a dead/closed connection here just means its own abort handler hasn't fired yet — it'll
      // unsubscribe itself momentarily; nothing to clean up from this side
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
