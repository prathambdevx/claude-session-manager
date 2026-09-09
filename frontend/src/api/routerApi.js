// Master Router client. Note POST /api/route only DECIDES — delivery is a separate
// sendQuickPrompt() call, so nothing is ever sent to a session without an explicit click.

/** Boots the backend's warm `claude` standby so the decision doesn't pay CLI startup. */
export async function warmRouter() {
  try {
    const res = await fetch("/api/route/warm", { method: "POST" });
    return await res.json();
  } catch {
    return { enabled: false, ready: false };
  }
}

/** Heuristic-only ranking — no model call. Cheap enough to hit on a typing debounce. */
export async function fetchRouteHint(task) {
  const res = await fetch("/api/route/hint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });
  return res.json();
}

/** The real decision: one model call, returns a target plus reasoning and confidence. */
export async function routeTask(task) {
  const res = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });
  return res.json();
}

export async function fetchRoutingConfig() {
  const res = await fetch("/api/route/config");
  return res.json();
}

export async function saveRoutingConfig(excludedProjects) {
  const res = await fetch("/api/route/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ excludedProjects }),
  });
  return res.json();
}
