import { join } from "node:path";
import { PROJECTS_DIR } from "../config.ts";
import { loadMeta } from "../store.ts";
import { scanAllSessions, keywordSearchScores, queryNeedles, matchSnippets, projectNameFromCwd } from "../sessions.ts";
import type { Session } from "../sessions.ts";
import { runClaudeHeadless } from "../claude/index.ts";
import { json } from "./json.ts";

export async function handleSearchRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/search" && req.method === "GET") {
    const raw = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (raw.length < 2) return json({ ids: [] });
    const scores = await keywordSearchScores(raw, 0.65);
    const ids = Object.keys(scores).sort((a, b) => scores[b] - scores[a]).slice(0, 20);
    return json({ ids });
  }

  if (url.pathname === "/api/search/smart" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const q = String(body?.q ?? "").trim();
    if (q.length < 2) return json({ ids: [] });
    const days = Number(body?.days) || 0; // 0 = all time
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;

    const sessions = await scanAllSessions();
    const meta = await loadMeta();
    const needles = queryNeedles(q.toLowerCase(), true);

    // cast a wide net for recall (low bar), then let Claude pick the true best matches from that pool
    const scores = await keywordSearchScores(q.toLowerCase(), 0.25);
    const poolIds = Object.keys(scores)
      .filter((id) => {
        if (!cutoff) return true;
        const s = sessions.find((x) => x.id === id);
        return s ? s.lastActive >= cutoff : false;
      })
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, 60);
    if (!poolIds.length) return json({ ids: [] });

    // re-rank the pool by co-occurrence density (best single-message snippet), not raw
    // term-count-anywhere — the session that actually DID the thing has the query terms clustered
    // in one message; sessions that merely mention a keyword have them scattered
    const ranked = (
      await Promise.all(
        poolIds.map(async (id) => {
          const s = sessions.find((x) => x.id === id);
          if (!s) return null;
          const { snippets, density } = await matchSnippets(join(PROJECTS_DIR, s.projectSlug, `${id}.jsonl`), needles);
          return { s, snippets, density };
        })
      )
    )
      .filter((r): r is { s: Session; snippets: string[]; density: number } => !!r)
      .sort((a, b) => b.density - a.density)
      .slice(0, 15);

    if (!ranked.length) return json({ ids: [] });
    const candidates = ranked.map((r) => r.s);

    const listing = ranked
      .map(({ s, snippets }, i) => {
        const m = meta[s.id] || {};
        const label = m.name || m.description || s.firstMessage || "(untitled)";
        const evidence = snippets.length ? snippets.join(" … ") : s.userMessageSample.slice(0, 2).join(" / ");
        return `${i + 1}. ${label.slice(0, 100)} — project: ${projectNameFromCwd(s.cwd)}\n   matches: ${evidence.slice(0, 700)}`;
      })
      .join("\n");

    const prompt =
      `A user is trying to find a past coding session matching this description:\n"${q}"\n\n` +
      `Here are candidate sessions, each with snippets from where the query terms actually appear in that session:\n${listing}\n\n` +
      "Pick the sessions that genuinely match the FULL description (not ones that just happen to mention a keyword). " +
      "Reply with ONLY the numbers, best match first, at most 3, comma-separated (e.g. \"4, 12\"). " +
      "If none genuinely match, reply with exactly NONE. No other text.";

    try {
      const result = await runClaudeHeadless(prompt, { tools: "", model: "sonnet", timeoutMs: 45000 });
      const numbers = [...new Set((result.match(/\d+/g) || []).map((n) => parseInt(n, 10)))].slice(0, 3);
      const ids = numbers.map((n) => candidates[n - 1]?.id).filter((id): id is string => !!id);
      return json({ ids });
    } catch (e: any) {
      return json({ error: e?.message ?? "smart search failed" }, { status: 500 });
    }
  }

  return null;
}
