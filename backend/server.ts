// Entry point: starts the local server and delegates every request to the router.
// Implementation lives in src/ — config, store, sessions, claude, html, routes.
import { PORT } from "./src/constants.ts";
import { handleRequest, startClearReconciliationPoller, startFsWatcher } from "./src/routes/index.ts";

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255, // Bun's cap; review/extract calls have their own internal timeouts
  fetch: handleRequest,
});

// Runs independently of any browser polling — otherwise a resume-then-/clear happening faster
// than the frontend's ~15s refresh could slip past before the pre-clear pid->session mapping is
// ever recorded, leaving nothing to carry over.
startClearReconciliationPoller();

// Live-updates the browser via SSE the instant Claude Code writes a status/transcript change or a
// Quick Prompt job file changes, instead of only finding out on the next scheduled poll — see
// src/fsWatcher.ts / src/sse.ts / routes/events.ts.
startFsWatcher();

console.log(`claude-sessions running at http://127.0.0.1:${server.port}`);
