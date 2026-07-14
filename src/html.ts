// Server-rendered HTML pages: the standalone review/context/delegation reports and index lists.
import type { Delegation } from "./store.ts";

export function escapeHtmlServer(s: string): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

const INDEX_STYLE =
  "body{font-family:-apple-system,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#151515;background:#fff}" +
  "h1{font-size:20px}.list{display:flex;flex-direction:column;gap:10px}" +
  ".card{display:block;text-decoration:none;color:inherit;border:1px solid #e2e2e0;border-radius:10px;padding:12px 14px}" +
  ".card:hover{border-color:#B27D14}.card .t{font-weight:600;font-size:14px}.card .m{font-size:12px;color:#6b6b6b;margin:2px 0}" +
  ".card .s{font-size:12.5px;color:#444;margin-top:4px}.empty{color:#6b6b6b}" +
  "@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.card{border-color:#2c2c2a}.card .s{color:#bbb}}";

export function delegationsIndexHtml(delegations: Delegation[]): string {
  const icon = (s: Delegation["status"]) => (s === "done" ? "✓" : s === "error" ? "✗" : "⏳");
  const rows = delegations
    .map((d) => {
      const when = new Date(d.createdAt).toLocaleString();
      const sub = d.status === "error" ? escapeHtmlServer(d.error || "failed") : d.status;
      return (
        `<a class="card" href="/delegations/${d.id}">` +
        `<div class="t">${icon(d.status)} ${escapeHtmlServer(d.agentEmoji + " " + d.agentName)} → ${escapeHtmlServer(d.sessionLabel)}</div>` +
        `<div class="m">${escapeHtmlServer(sub)} · ${when}</div></a>`
      );
    })
    .join("");
  const body =
    `<h1>Delegations (${delegations.length})</h1>` +
    (delegations.length ? `<div class="list">${rows}</div>` : `<p class="empty">No delegations yet.</p>`);
  return `<!doctype html><html><head><meta charset='utf-8'><title>Delegations</title><style>${INDEX_STYLE}</style></head><body>${body}</body></html>`;
}

export function reviewsIndexHtml(body: string): string {
  return (
    "<!doctype html><html><head><meta charset='utf-8'><title>Reviews</title><style>" +
    "body{font-family:-apple-system,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#151515;background:#fff}" +
    "h1{font-size:20px}.list{display:flex;flex-direction:column;gap:10px}" +
    ".card{display:block;text-decoration:none;color:inherit;border:1px solid #e2e2e0;border-radius:10px;padding:12px 14px}" +
    ".card:hover{border-color:#B27D14}.card .t{font-weight:600;font-size:14px}.card .m{font-size:12px;color:#6b6b6b;margin:2px 0}" +
    ".card .s{font-size:12.5px;color:#444;margin-top:4px}.empty{color:#6b6b6b}" +
    "@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.card{border-color:#2c2c2a}.card .s{color:#bbb}}" +
    "</style></head><body>" + body + "</body></html>"
  );
}

// crude Markdown → HTML for opening a report in a new browser tab
export function markdownToHtml(md: string, title = "Review report"): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
  const lines = esc(md).split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    const item = line.match(/^(?:\d+\.|-)\s+(.*)/);
    if (heading) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = Math.min(heading[1].length + 2, 6);
      html += `<h${level}>${heading[2]}</h${level}>`;
    } else if (item) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${item[1]}</li>`;
    } else if (line.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${line}</p>`;
    }
  }
  if (inList) html += "</ul>";
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  return (
    `<!doctype html><html><head><meta charset='utf-8'><title>${title}</title><style>` +
    "body{font-family:-apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#151515;background:#fff}" +
    "h1,h2,h3,h4{margin-top:1.4em}code{background:#f2f2f0;padding:1px 5px;border-radius:4px;font-size:0.9em}" +
    "li{margin:8px 0}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#292926}}" +
    "</style></head><body>" + html + "</body></html>"
  );
}
