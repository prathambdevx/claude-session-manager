// Live-update channel — listens on the server's SSE stream (backend/src/fsWatcher.ts is what
// decides when to push, backend/src/routes/events.ts is the actual endpoint) and applies each
// granular push straight into local state, in place, instead of re-fetching the whole /api/sessions
// bundle on every change. A push is one of: a session's fresh full data (upsert by id), a session
// removed (its transcript was deleted), a lightweight running-status patch (busy/idle/waiting or the
// process exiting — no transcript re-scan needed for that), or a Quick Prompt job upserted/removed.
// Both the session activity/done chip and Quick Prompt's own job chip read straight off `sessions`/
// `quickPrompts` in state.js, so patching those in place here updates both the moment a push arrives.
import { sessions, quickPrompts } from "../state.js";
import { render } from "../pages/sessionsPage.js";

const ACTIVITY_WINDOW_MS = 15_000; // mirrors backend/src/sessions.ts's ACTIVITY_WINDOW_MS exactly

function computeActivelyWorking(s) {
  return s.running?.status === "busy" || Date.now() - s.lastActive < ACTIVITY_WINDOW_MS;
}

function upsertSession(fresh) {
  const i = sessions.findIndex((x) => x.id === fresh.id);
  if (i === -1) sessions.push(fresh);
  else sessions[i] = fresh; // a "session" push always carries the session's complete current data, not a partial patch
}

function removeSession(id) {
  const i = sessions.findIndex((x) => x.id === id);
  if (i !== -1) sessions.splice(i, 1);
}

function patchSession(id, patch) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return; // a session we haven't loaded yet — nothing local to patch; the next full push or backstop poll will pick it up
  Object.assign(s, patch);
  s.activelyWorking = computeActivelyWorking(s);
}

function upsertQuickPrompt(job) {
  const i = quickPrompts.findIndex((x) => x.id === job.id);
  if (i === -1) quickPrompts.push(job);
  else quickPrompts[i] = job;
}

function removeQuickPrompt(id) {
  const i = quickPrompts.findIndex((x) => x.id === id);
  if (i !== -1) quickPrompts.splice(i, 1);
}

export function initLiveUpdates() {
  const source = new EventSource("/api/events");
  source.onmessage = (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      return; // heartbeat/comment lines never reach onmessage at all — this is just defensive
    }
    switch (event.type) {
      case "session":
        upsertSession(event.session);
        break;
      case "session-removed":
        removeSession(event.id);
        break;
      case "session-patch":
        patchSession(event.id, event.patch);
        break;
      case "quickprompt":
        upsertQuickPrompt(event.job);
        break;
      case "quickprompt-removed":
        removeQuickPrompt(event.id);
        break;
      default:
        return;
    }
    render();
  };
  // EventSource reconnects on its own (default browser behavior) after a drop — nothing to do here
  // for that; onerror is only for visibility, not recovery.
  source.onerror = () => {
    // transient — the browser is already retrying; the slow backstop poll in main.js covers the
    // gap while a reconnect is in flight
  };
}
