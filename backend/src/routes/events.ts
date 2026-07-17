// GET /api/events — the browser's live-update channel (see sse.ts for the pub/sub hub this reads
// from, fsWatcher.ts for what actually triggers a push). Kept open for the lifetime of the tab;
// the frontend's EventSource reconnects on its own if this drops (server restart, network blip).
import { subscribe, unsubscribe } from "../sse.ts";

const HEARTBEAT_MS = 25_000; // keeps intermediary proxies/browsers from treating this as a dead/idle connection

export async function handleEventsRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/events" || req.method !== "GET") return null;

  let heartbeat: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const client = { write: (chunk: string) => controller.enqueue(encoder.encode(chunk)) };
      subscribe(client);
      client.write(": connected\n\n"); // a leading colon is an SSE comment line — establishes the stream without counting as a real event
      heartbeat = setInterval(() => client.write(": ping\n\n"), HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe(client);
        try {
          controller.close();
        } catch {
          // already closed from the other end
        }
      });
    },
    cancel() {
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
