// Entry point: starts the local server and delegates every request to the router.
// Implementation lives in src/ — config, store, sessions, claude, html, routes.
import { PORT } from "./src/config.ts";
import { handleRequest } from "./src/routes.ts";

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255, // Bun's cap; review/extract calls have their own internal timeouts
  fetch: handleRequest,
});

console.log(`claude-sessions running at http://127.0.0.1:${server.port}`);
