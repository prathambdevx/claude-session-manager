// Master Router page: hand it a task, it decides which existing session should take it (or that a
// new one should), then you click to send. It never sends on its own — see the ADR
// (docs/adr/0001-master-session-router.md) for why confirm-before-send is deliberate.
import { warmRouter, routeTask } from "../api/routerApi.js";
import { sendQuickPrompt } from "../api/quickPromptsApi.js";
import { toast } from "../ui/toast.js";

let hintTimer = null;
let warmTimer = null;
let state = {
  task: "",
  candidates: [],
  decision: null,
  degraded: false,
  warm: null,
  loading: false,
  chosenId: null, // user override of decision.targetId
  sent: false,
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Relative while it is still "recent" (that is the useful reading for a live session), then a real
// clock time — "5h ago" tells you nothing you can act on, "3:05 AM" does.
function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return time;
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${day}, ${time}`;
}

function candidateHtml(c, activeId) {
  const isTarget = c.id === activeId;
  return `
    <div class="rt-cand ${isTarget ? "rt-target" : ""}" data-cand="${esc(c.id)}">
      <div class="rt-cand-top">
        <span class="dot ${c.live ? "live" : "idle"}"></span>
        <div class="rt-cand-main">
          <div class="rt-cand-title">${esc(c.label)}</div>
          ${c.summary ? `<div class="rt-cand-sum">${esc(c.summary)}</div>` : `<div class="rt-cand-sum rt-nodigest">no digest yet — routing from recent activity only</div>`}
        </div>
      </div>
      <div class="meta-row">
        <span class="chip">${esc(c.project)}</span>
        ${c.branch ? `<span class="chip branch">${esc(c.branch)}</span>` : ""}
        <span class="chip">${ago(c.lastActive)}</span>
        ${c.busy ? `<span class="chip rt-busy">busy</span>` : ""}
        ${!c.hasDigest ? `<span class="chip rt-warming">warming</span>` : ""}
      </div>
      ${c.files.length ? `<div class="rt-files">${c.files.map((f) => `<code>${esc(f.split("/").slice(-2).join("/"))}</code>`).join(" ")}</div>` : ""}
      ${isTarget ? "" : `<button class="btn ghost rt-pick" data-pick="${esc(c.id)}">Route here instead</button>`}
    </div>`;
}

function decisionHtml() {
  const { decision, candidates, degraded, chosenId } = state;
  if (!decision) return "";
  const activeId = chosenId ?? decision.targetId;
  const target = candidates.find((c) => c.id === activeId);

  if (decision.isNew || (!target && !decision.targetId)) {
    return `
      <div class="rt-decision ${decision.confidence === "low" ? "rt-low" : ""}">
        <div class="rt-decision-head">＋ Start a new session${decision.suggestedProject ? ` in <b>${esc(decision.suggestedProject)}</b>` : ""}</div>
        <div class="rt-reason"><b>Why:</b> ${esc(decision.reason)}</div>
        <div class="rt-conf">confidence: <b>${esc(decision.confidence)}</b>${degraded ? ` · <span class="rt-degraded">degraded</span>` : ""}</div>
        <div class="rt-actions"><span class="qp-hint">Pick a session below to route there instead, or launch a new session from the Sessions tab.</span></div>
      </div>`;
  }

  const low = decision.confidence === "low";
  return `
    <div class="rt-decision ${low ? "rt-low" : ""}">
      <div class="rt-decision-head">${low ? "No confident match" : "Route to"}: <b>${esc(target?.label ?? "—")}</b></div>
      <div class="rt-reason"><b>Why:</b> ${esc(decision.reason)}</div>
      <div class="rt-conf">
        confidence: <b>${esc(decision.confidence)}</b>
        ${chosenId ? " · <i>your override</i>" : ""}
        ${degraded ? ' · <span class="rt-degraded">degraded — model call failed, this is a file/project overlap guess</span>' : ""}
      </div>
      <div class="rt-actions">
        <button class="primary" id="rtSend" ${state.sent ? "disabled" : ""}>${state.sent ? "Sent ✓" : `Send to ${esc((target?.label ?? "").slice(0, 28))}`}</button>
        ${target?.busy ? `<span class="qp-hint">This session is mid-turn — it'll be delivered in the background.</span>` : ""}
      </div>
    </div>`;
}

export function renderRouterPage() {
  const root = document.getElementById("routerApp");
  if (!root) return;
  const activeId = state.chosenId ?? state.decision?.targetId ?? null;
  const warmLabel = state.warm?.ready ? "ready" : state.warm?.enabled ? "warming…" : "cold";

  root.innerHTML = `
    <div class="wrap">
      <div class="view-title-row"><h2 class="view-title">🧭 Master Router</h2>
        <span class="read-only-badge">decides where a task goes · never sends without your click</span></div>

      <div class="rt-panel">
        <label for="rtTask">What do you need done?</label>
        <textarea id="rtTask" placeholder="e.g. the wishlist product cards render blank on dev but fine on prod">${esc(state.task)}</textarea>
        <div class="rt-panel-foot">
          <button class="primary" id="rtGo" ${state.loading ? "disabled" : ""}>${state.loading ? "Routing…" : "🧭 Route this task"}</button>
          <span class="qp-hint">router: <b>${warmLabel}</b>${state.candidates.length ? ` · ${state.candidates.length} candidate${state.candidates.length === 1 ? "" : "s"}` : ""}</span>
        </div>
      </div>

      ${decisionHtml()}

      ${
        // The candidate list exists ONLY to override a decision, so it appears only once there is
        // one. Listing 25 sessions before you have asked anything was pure noise — and with the
        // lexical scores removed it carried no signal at all, just cards to scroll past.
        state.decision && state.candidates.length
          ? `<div class="section-label">Candidates considered — pick one to route there instead</div>
             <div class="rt-cands">${state.candidates.map((c) => candidateHtml(c, activeId)).join("")}</div>`
          : ""
      }
    </div>`;

  wire();
}

function wire() {
  const ta = document.getElementById("rtTask");
  if (ta) {
    ta.addEventListener("input", (e) => {
      state.task = e.target.value;
      state.refocus = true;
      state.decision = null;
      state.chosenId = null;
      state.sent = false;
      // No per-keystroke refetch. The candidate list is a chooser, not a ranking, so it does not
      // change as you type; the lexical scorer that used to reorder it live was measured at 60%
      // P@1 with a no-fit band overlapping real matches by 25 points, which is not worth showing.
      // Warming the backend process is still worth doing while you type.
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => warmRouter(), 300);
    });
    // Restore focus and caret only if the user was already typing here. Unconditionally calling
    // focus() on every rerender steals focus from whatever else was clicked (e.g. a "Route here
    // instead" button) and yanks the page back to the textarea.
    if (state.refocus) {
      ta.focus();
      ta.setSelectionRange(state.task.length, state.task.length);
      state.refocus = false;
    }
  }
  document.getElementById("rtGo")?.addEventListener("click", runRoute);
  document.getElementById("rtSend")?.addEventListener("click", send);
  document.querySelectorAll("[data-pick]").forEach((b) =>
    b.addEventListener("click", () => {
      state.chosenId = b.getAttribute("data-pick");
      state.sent = false;
      renderRouterPage();
    })
  );
}

async function runRoute() {
  const task = state.task.trim();
  if (task.length < 3) {
    toast("Describe the task first");
    return;
  }
  state.loading = true;
  state.sent = false;
  state.chosenId = null;
  renderRouterPage();
  try {
    const data = await routeTask(task);
    if (data.error) {
      toast("Routing failed: " + data.error);
    } else {
      state.candidates = data.candidates ?? [];
      state.decision = data.decision ?? null;
      state.degraded = !!data.degraded;
      state.warm = data.warm ?? state.warm;
    }
  } catch (e) {
    toast("Routing failed: " + (e?.message ?? "unknown error"));
  } finally {
    state.loading = false;
    renderRouterPage();
  }
}

async function send() {
  const id = state.chosenId ?? state.decision?.targetId;
  if (!id) return;
  const btn = document.getElementById("rtSend");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }
  const res = await sendQuickPrompt(id, state.task.trim());
  if (res?.ok) state.sent = true;
  renderRouterPage();
}

/**
 * Poll the warm status while it's booting. Without this the label latched on whatever the single
 * page-open fetch saw — which is always "warming", because the standby is spawned by that very
 * request and needs ~7.5s to finish booting. Stops as soon as it's ready.
 */
function pollWarmUntilReady() {
  clearInterval(warmTimer);
  warmTimer = setInterval(async () => {
    const st = await warmRouter();
    const changed = st.ready !== state.warm?.ready || st.enabled !== state.warm?.enabled;
    state.warm = st;
    if (st.ready || !st.enabled) clearInterval(warmTimer);
    // only repaint on an actual change, so this never fights the textarea mid-keystroke
    if (changed) renderRouterPage();
  }, 1500);
}

/** Called when the tab opens — warms the backend standby so the first decision is fast. */
export async function onRouterPageOpen() {
  state.warm = await warmRouter();
  renderRouterPage();
  // No candidate prefetch: nothing is displayed until you route, so fetching 25 sessions' digests
  // and tails on page open was work with nothing to show for it.
  pollWarmUntilReady();
}
