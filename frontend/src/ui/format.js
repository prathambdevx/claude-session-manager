// Pure, stateless formatting/escaping helpers — no session/board state, safe to import anywhere.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
export function escapeAttr(s) { return escapeHtml(s); }

export function fmtTime(ms) {
  const d = new Date(ms);
  const now = Date.now();
  const diffH = (now - ms) / 3600000;
  if (diffH < 24) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffH < 24 * 7) return d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function projectName(cwd) {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
