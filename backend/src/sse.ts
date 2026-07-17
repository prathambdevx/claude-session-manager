// Server-Sent Events hub: a tiny one-way pub/sub that pushes granular, typed events straight to
// every connected browser tab — a changed session's full up-to-date data, a patch to just its
// running/activelyWorking fields, a removal, or a Quick Prompt job update — instead of a bare
// "something changed, go refetch everything" nudge. fsWatcher.ts is the only thing that calls
// broadcast() (see it for the event shapes); routes/events.ts is the only thing that calls
// subscribe()/unsubscribe() (one pair per connected browser tab's open /api/events request).
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
