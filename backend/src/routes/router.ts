// Master Router endpoints. POST /api/route DECIDES; it never sends. Delivery stays a separate call
// to the existing Quick Prompt path (routes/quickPrompts.ts), which keeps this endpoint safe to
// call speculatively, trivial to test, and impossible to fire a prompt into a session by accident.
import { loadRoutingConfig, saveRoutingConfig, isRouterEnabled } from "../routing/config.ts";
import { gatherCandidates, decideRoute, heuristicDetail, type RouteCandidate } from "../routing/decide.ts";
import { queueDigestCatchUp, digestQueueDepth, flushDigestQueue } from "../routing/worker.ts";
import { startWarmPool, warmPoolStatus, stopWarmPool } from "../claude/warmPool.ts";
import { scanAllSessions, projectNameFromCwd } from "../sessions/index.ts";
import { json } from "./json.ts";

// What the browser needs. Deliberately NO score: the lexical heuristic is kept for candidate
// prefiltering and as the degraded fallback, but it is not shown to the user — measured at 60% P@1
// with a no-fit band overlapping genuine matches by 25 points, a percentage that misleads more than
// it informs.
function publicCandidate(c: RouteCandidate) {
  return {
    id: c.id,
    label: c.label,
    project: c.project,
    cwd: c.cwd,
    branch: c.branch,
    lastActive: c.lastActive,
    live: c.live,
    busy: c.busy,
    files: c.files.slice(0, 8),
    summary: c.digest?.chunks.at(-1)?.summary ?? c.digest?.earlier ?? "",
    hasDigest: !!(c.digest?.chunks.length || c.digest?.earlier),
  };
}

export async function handleRouterRoutes(req: Request, url: URL): Promise<Response | null> {
  // Global kill switch (routing-config.json `enabled`) — stops the decision endpoints AND the
  // background digest worker (see isRouterEnabled() in worker.ts). Config/GET stays reachable so
  // the toggle itself is always readable even while everything else is off.
  const routerPaths = ["/api/route", "/api/route/hint", "/api/route/warm"];
  if (routerPaths.includes(url.pathname) && !isRouterEnabled()) {
    return json({ error: "router disabled", enabled: false }, { status: 503 });
  }

  // Live hint while typing: heuristic only, no model call. Cheap enough to hit on a debounce.
  // Called when the Router UI opens, and again as you type. Boots the standby `claude` process so
  // the decision doesn't pay ~7.5s of CLI startup — the time spent typing covers the boot.
  if (url.pathname === "/api/route/warm" && req.method === "POST") {
    startWarmPool("sonnet");
    return json(warmPoolStatus());
  }

  if (url.pathname === "/api/route/hint" && req.method === "POST") {
    startWarmPool("sonnet"); // typing is the warm-up window
    const body = await req.json().catch(() => ({}));
    const task = String((body as any)?.task ?? "").trim();
    const candidates = await gatherCandidates(task);
    return json({
      candidates: candidates.map(publicCandidate),
      warming: digestQueueDepth(),
      warm: warmPoolStatus(),
    });
  }

  if (url.pathname === "/api/route" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const task = String((body as any)?.task ?? "").trim();
    if (task.length < 3) return json({ error: "task too short" }, { status: 400 });

    startWarmPool("sonnet"); // extend the warm window for a likely follow-up route
    const candidates = await gatherCandidates(task);
    // Keep every candidate's digest converging in the background. Not awaited — a first-run
    // request must not block on backfilling hundreds of chunks.
    for (const c of candidates) queueDigestCatchUp(c.id, c.projectSlug);

    if (!candidates.length) {
      return json({
        candidates: [],
        decision: { targetId: null, isNew: true, suggestedProject: null, confidence: "high", reason: "no live or recent sessions to route to" },
        degraded: false,
        warming: digestQueueDepth(),
      });
    }

    const projects = [...new Set((await scanAllSessions()).map((s) => projectNameFromCwd(s.cwd)))];
    const cfg = await loadRoutingConfig();
    const routableProjects = projects.filter((p) => !cfg.excludedProjects.includes(p));

    try {
      const decision = await decideRoute(task, candidates, routableProjects);
      return json({ candidates: candidates.map(publicCandidate), decision, degraded: false, warming: digestQueueDepth(), warm: warmPoolStatus() });
    } catch (e: any) {
      // Model call failed or timed out. Fall back to the heuristic's top pick, but say so — a
      // degraded guess presented as a decision is worse than no decision.
      // Sort by rawScore, not the gated score: the gate is a DISPLAY honesty device, and sorting
      // by it made a near-miss at raw 0.8 lose to a gate-passing candidate at raw 0.3. And if
      // nothing has any evidence at all, say so rather than naming candidates[0] as a "best guess".
      const detail = heuristicDetail(task, candidates);
      const ranked = [...candidates].sort(
        (a, b) => (detail.get(b.id)?.rawScore ?? 0) - (detail.get(a.id)?.rawScore ?? 0)
      );
      const best = (detail.get(ranked[0]?.id ?? "")?.rawScore ?? 0) > 0 ? ranked[0] : undefined;
      return json({
        candidates: candidates.map(publicCandidate),
        decision: {
          targetId: best?.id ?? null,
          isNew: false,
          suggestedProject: null,
          confidence: "low",
          reason: best
            ? `router unavailable (${e?.message ?? "error"}) — best guess from file and project overlap`
            : `router unavailable (${e?.message ?? "error"}) and no session shows any matching evidence`,
        },
        degraded: true,
        warming: digestQueueDepth(),
      });
    }
  }

  if (url.pathname === "/api/route/config" && req.method === "GET") {
    return json(await loadRoutingConfig());
  }

  if (url.pathname === "/api/route/config" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const excludedProjects = Array.isArray((body as any)?.excludedProjects)
      ? (body as any).excludedProjects.map(String)
      : [];
    const prev = await loadRoutingConfig();
    const enabled = typeof (body as any)?.enabled === "boolean" ? (body as any).enabled : prev.enabled;
    await saveRoutingConfig({ excludedProjects, enabled });
    // Kill in-flight/queued work immediately rather than only blocking new enqueues — otherwise
    // already-queued digest jobs kept running to completion after the toggle flipped off.
    if (!enabled) {
      flushDigestQueue();
      stopWarmPool();
    }
    return json({ ok: true, excludedProjects, enabled });
  }

  return null;
}
