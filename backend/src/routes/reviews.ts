import { readdir } from "node:fs/promises";
import { REVIEWS_DIR, KNOWN_MODELS, CLAUDE_BIN, EFFORT_FLAG, DANGEROUS_FLAG } from "../config.ts";
import { loadMeta, saveMeta, saveReview, loadReview } from "../store.ts";
import type { ReviewRecord } from "../store.ts";
import { scanAllSessions, projectNameFromCwd } from "../sessions.ts";
import { runClaudeHeadless, buildFileReviewPrompt, buildFixPrompt, modelAliasWithContext, shellQuote, openTerminalRunning } from "../claude/index.ts";
import { escapeHtmlServer, reviewsIndexHtml, markdownToHtml } from "../html.ts";
import { json } from "./json.ts";

export async function handleReviewsRoutes(req: Request, url: URL): Promise<Response | null> {
  const reviewMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "POST") {
    const id = reviewMatch[1];
    const body = await req.json().catch(() => ({}));
    const model = KNOWN_MODELS.has(body?.model) ? body.model : null;
    const focus = String(body?.focus ?? "").trim().slice(0, 300) || undefined;
    const sessions = await scanAllSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return json({ error: "session not found" }, { status: 404 });
    if (!s.changedFiles.length) return json({ error: "no changed files found for this session" }, { status: 422 });
    const prompt = buildFileReviewPrompt(s.changedFiles, focus);
    try {
      // read-only: the reviewer can inspect files but never edit them here — fixing is a separate, supervised step
      const markdown = await runClaudeHeadless(prompt, {
        cwd: s.cwd,
        model: model || "sonnet",
        disallowedTools: "Edit,Write,NotebookEdit",
        timeoutMs: 240000,
      });
      const reviewId = crypto.randomUUID();
      const review: ReviewRecord = { id: reviewId, sessionId: id, cwd: s.cwd, files: s.changedFiles, model, createdAt: Date.now(), markdown };
      await saveReview(review);
      const meta = await loadMeta();
      meta[id] = { ...meta[id], lastReviewId: reviewId };
      await saveMeta(meta);
      return json({ ok: true, reviewId, fileCount: s.changedFiles.length });
    } catch (e: any) {
      return json({ error: e?.message ?? "review failed" }, { status: 500 });
    }
  }

  const reviewGetMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)$/);
  if (reviewGetMatch && req.method === "GET") {
    const review = await loadReview(reviewGetMatch[1]);
    if (!review) return json({ error: "review not found" }, { status: 404 });
    return json({ review });
  }

  if (url.pathname === "/reviews" && req.method === "GET") {
    let files: string[] = [];
    try {
      files = (await readdir(REVIEWS_DIR)).filter((f) => f.endsWith(".json"));
    } catch {
      // no reviews dir yet
    }
    const reviews = (await Promise.all(files.map((f) => loadReview(f.replace(/\.json$/, "")))))
      .filter((r): r is ReviewRecord => !!r)
      .sort((a, b) => b.createdAt - a.createdAt);
    const meta = await loadMeta();
    const rows = reviews
      .map((r) => {
        const label = meta[r.sessionId]?.name || meta[r.sessionId]?.description || r.sessionId;
        const firstLine = (r.markdown.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "").slice(0, 160);
        return (
          `<a class="card" href="/reviews/${r.id}">` +
          `<div class="t">${escapeHtmlServer(label)}</div>` +
          `<div class="m">${projectNameFromCwd(r.cwd)} · ${r.files.length} file${r.files.length === 1 ? "" : "s"}${r.model ? " · " + r.model : ""}</div>` +
          `<div class="s">${escapeHtmlServer(firstLine)}</div></a>`
        );
      })
      .join("");
    const body =
      `<h1>Reviews (${reviews.length})</h1>` +
      (reviews.length ? `<div class="list">${rows}</div>` : `<p class="empty">No reviews yet.</p>`);
    return new Response(reviewsIndexHtml(body), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const reviewPageMatch = url.pathname.match(/^\/reviews\/([^/]+)$/);
  if (reviewPageMatch && req.method === "GET") {
    const review = await loadReview(reviewPageMatch[1]);
    if (!review) return new Response("Review not found", { status: 404 });
    return new Response(markdownToHtml(review.markdown), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const fixMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/fix$/);
  if (fixMatch && req.method === "POST") {
    const review = await loadReview(fixMatch[1]);
    if (!review) return json({ error: "review not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const writeTests = Boolean(body?.writeTests);
    let selection: "all" | number[] = "all";
    if (body?.selection !== "all") {
      const nums = String(body?.selection ?? "")
        .split(/[,\s]+/)
        .map((n: string) => parseInt(n, 10))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      if (!nums.length) return json({ error: "no valid finding numbers given" }, { status: 400 });
      selection = nums;
    }
    const dangerous = body?.dangerous !== false;
    const prompt = buildFixPrompt(review, selection, writeTests);
    const modelFlag = review.model ? ` --model ${modelAliasWithContext(review.model)}` : "";
    const cmd = `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${dangerous ? DANGEROUS_FLAG : ""} ${shellQuote(prompt)}`;
    await openTerminalRunning(review.cwd, cmd);
    return json({ ok: true, cwd: review.cwd, selection });
  }

  return null;
}
