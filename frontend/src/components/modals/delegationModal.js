import { delegationPoll, setDelegationPoll } from "../../state.js";
import { modalShell, closeModal } from "../../ui/modalShell.js";
import { escapeHtml, projectName } from "../../ui/format.js";
import { toast } from "../../ui/toast.js";
import { loadSessions } from "../../api/sessionsApi.js";

export function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export async function openDelegationModal(id) {
  if (delegationPoll) { clearInterval(delegationPoll); setDelegationPoll(null); }

  const paint = async () => {
    let d;
    try {
      d = (await (await fetch(`/api/delegations/${id}`)).json()).delegation;
    } catch {
      return;
    }
    if (!d) { closeModal(); toast("Delegation not found"); return; }

    const dot = d.status === "running" ? "⏳" : d.status === "done" ? "✓" : "✗";
    const elapsed = fmtElapsed((d.finishedAt || Date.now()) - d.createdAt);
    const activity = (d.progress || []);
    const activityHtml = activity.length
      ? activity.map((l) => `<div class="act-line">${escapeHtml(l)}</div>`).join("")
      : '<div class="act-line" style="color:var(--dim)">waiting for the agent to start…</div>';

    let footer = "";
    if (d.status === "running") {
      footer = `<button class="danger" id="delKill">■ Kill</button><span style="flex:1"></span><button id="delClose">Close</button>`;
    } else if (d.status === "done") {
      footer = `<a href="/delegations/${id}" target="_blank" rel="noopener" style="text-decoration:none;"><button class="primary">📄 Open full result ↗</button></a><span style="flex:1"></span><button id="delClose">Close</button>`;
    } else {
      footer = `<span style="flex:1"></span><button id="delClose">Close</button>`;
    }

    const bodyBlock =
      d.status === "done"
        ? `<div class="modal-row"><label>Result</label><div class="del-result">${escapeHtml((d.result || "").slice(0, 1200))}${(d.result || "").length > 1200 ? "…" : ""}</div></div>`
        : d.status === "error"
        ? `<div class="modal-row"><label>Error</label><div class="del-result" style="color:var(--danger)">${escapeHtml(d.error || "failed")}</div></div>`
        : "";

    modalShell(
      `<div id="delegationModal">
        <h3>${dot} ${escapeHtml(d.agentEmoji + " " + d.agentName)}</h3>
        <div style="font-size:12px; color:var(--dim);">on <b>${escapeHtml(d.sessionLabel)}</b> · ${escapeHtml(projectName(d.cwd))} · ${d.status} · ${elapsed}</div>
        <div class="modal-row">
          <label>${d.status === "running" ? "Live activity" : "Activity"} (${activity.length})</label>
          <div class="act-log">${activityHtml}</div>
        </div>
        ${bodyBlock}
        <div class="modal-actions">${footer}</div>
      </div>`,
      620
    );
    document.getElementById("delClose")?.addEventListener("click", closeModal);
    document.getElementById("delKill")?.addEventListener("click", async () => {
      await fetch(`/api/delegations/${id}/cancel`, { method: "POST" });
      toast("Delegation killed");
      paint();
      loadSessions();
    });

    if (d.status !== "running" && delegationPoll) { clearInterval(delegationPoll); setDelegationPoll(null); }
  };

  await paint();
  // live-refresh while running; stop if the user closed the modal
  setDelegationPoll(setInterval(() => {
    if (!document.getElementById("delegationModal")) { clearInterval(delegationPoll); setDelegationPoll(null); return; }
    paint();
  }, 2000));
}
