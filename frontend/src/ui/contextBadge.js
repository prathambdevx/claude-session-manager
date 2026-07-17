// Pure HTML-fragment builders given a session-shaped object — only touch the passed argument.

export function ctxBadgeFullHtml(s) {
  if (s.contextPct == null) return "";
  const level = s.contextPct >= 80 ? "red" : s.contextPct >= 50 ? "yellow" : "green";
  return `
    <div class="ctx-bar-full ctx-${level}" title="~${s.contextTokens.toLocaleString()} tokens (~${s.contextPct}% of ${((s.contextWindow || 200000) / 1000).toFixed(0)}k)">
      <div class="ctx-track"><div class="ctx-fill" style="width:${s.contextPct}%"></div></div>
      <span class="ctx-label">${s.contextPct}%</span>
    </div>`;
}

export function ctxBadgeHtml(s) {
  if (s.contextPct == null) return "";
  const level = s.contextPct >= 80 ? "red" : s.contextPct >= 50 ? "yellow" : "green";
  return `
    <span class="ctx-badge ctx-${level}" title="~${s.contextTokens.toLocaleString()} tokens in context (~${s.contextPct}% of a ${((s.contextWindow || 200000) / 1000).toFixed(0)}k window)">
      <span class="bar"><span style="width:${s.contextPct}%"></span></span>
      ${s.contextPct}%
    </span>
  `;
}
