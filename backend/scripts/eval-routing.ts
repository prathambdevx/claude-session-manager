// Offline accuracy harness for the Master Router's lexical scorer. Run:
//   bun backend/scripts/eval-routing.ts
//
// Reports precision@1 and MRR over labelled cases, plus the SEPARATION between genuine matches and
// tasks that fit nothing — the second number matters as much as the first, because a scorer that
// rates an unrelated task as highly as a real one is useless for deciding "start a new session".
//
// Scores against every session that HAS a digest, deliberately bypassing gatherCandidates' 24h
// recency window, so the ranking pool is the same on every run and results stay comparable.
//
// Cases live in data/routing-eval.json — session ids are machine-local, which is why they are not
// checked into the repo tree. Do not run this while a digest backfill is rewriting the pool.
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { DATA_DIR, PROJECTS_DIR } from "../src/constants.ts";
import { heuristicDetail, type RouteCandidate } from "../src/routing/decide.ts";
import { loadDigest, readRawTail } from "../src/routing/digest.ts";
import { scanAllSessions, projectNameFromCwd } from "../src/sessions/index.ts";
import { isRoutingRelevantFile } from "../src/sessions/entries.ts";

type Spec = { cases: { q: string; want: string }[]; noFit: string[] };

const spec: Spec = JSON.parse(await readFile(join(DATA_DIR, "routing-eval.json"), "utf-8"));

const pool: RouteCandidate[] = [];
for (const s of await scanAllSessions()) {
  const digest = await loadDigest(s.id);
  if (!digest) continue;
  pool.push({
    id: s.id,
    projectSlug: s.projectSlug,
    label: s.firstMessage?.slice(0, 80) ?? "(untitled)",
    project: projectNameFromCwd(s.cwd),
    cwd: s.cwd,
    branch: s.gitBranch,
    lastActive: s.lastActive,
    live: false,
    busy: false,
    files: [...new Set([...digest.files, ...s.changedFiles])].filter(isRoutingRelevantFile).slice(0, 40),
    digest,
    tail: await readRawTail(join(PROJECTS_DIR, s.projectSlug, `${s.id}.jsonl`), digest.coveredBytes),
    score: 0,
  });
}

if (pool.length < 2) {
  console.log(`pool has ${pool.length} digested session(s) — not enough to rank. Let digests build first.`);
  process.exit(0);
}

console.log(`pool: ${pool.length} digested sessions | ${spec.cases.length} labelled + ${spec.noFit.length} no-fit\n`);

let hits = 0;
let mrr = 0;
const matchScores: number[] = [];

for (const { q, want } of spec.cases) {
  const detail = heuristicDetail(q, pool);
  // Rank on rawScore, NOT the gated score. The gate is a display device: everything below
  // MIN_CLAIMABLE ties at exactly 0, so sorting by it made the ordering of all those candidates
  // arbitrary and reported a correct-but-quiet target as "rank 8".
  const ranked = [...pool].sort((a, b) => detail.get(b.id)!.rawScore - detail.get(a.id)!.rawScore);
  const rank = ranked.findIndex((c) => c.id.startsWith(want)) + 1;
  if (rank === 1) hits++;
  if (rank > 0) mrr += 1 / rank;

  const target = ranked[rank - 1] ? detail.get(ranked[rank - 1].id)! : null;
  const top = detail.get(ranked[0].id)!;
  matchScores.push(Math.round(top.rawScore * 100));
  const topName = ranked[0].id.slice(0, 8);
  console.log(
    `${rank === 1 ? "PASS" : "FAIL"} rank=${String(rank || "-").padStart(2)} ` +
      // the TARGET's own numbers, then who beat it — reporting the winner's stats told us nothing
      // about why the answer lost
      `want ${String(Math.round((target?.rawScore ?? 0) * 100)).padStart(3)}% ${String((target?.matched ?? 0) + "/" + (target?.total ?? 0)).padStart(5)}` +
      `  got ${topName} ${String(Math.round(top.rawScore * 100)).padStart(3)}%  ${q.slice(0, 44)}`
  );
}

const noFitScores: number[] = [];
console.log("");
for (const q of spec.noFit) {
  const detail = heuristicDetail(q, pool);
  // no-fit uses the GATED score deliberately: the question is what we would SHOW the user
  const top = [...pool].map((c) => detail.get(c.id)!).sort((a, b) => b.score - a.score)[0];
  noFitScores.push(Math.round(top.score * 100));
  console.log(`NOFIT     shown ${String(Math.round(top.score * 100)).padStart(3)}% ${String(top.matched + "/" + top.total).padStart(5)}  ${q.slice(0, 44)}`);
}

const lo = (a: number[]) => Math.min(...a);
const hi = (a: number[]) => Math.max(...a);
console.log(`\nP@1        : ${hits}/${spec.cases.length} = ${((hits / spec.cases.length) * 100).toFixed(0)}%`);
console.log(`MRR        : ${(mrr / spec.cases.length).toFixed(3)}`);
console.log(`match band : ${lo(matchScores)}-${hi(matchScores)}%`);
console.log(`no-fit band: ${lo(noFitScores)}-${hi(noFitScores)}%`);
console.log(
  hi(noFitScores) < lo(matchScores)
    ? `separation : CLEAN (no-fit tops out ${hi(noFitScores)}% below matches at ${lo(matchScores)}%)`
    : `separation : OVERLAP of ${hi(noFitScores) - lo(matchScores)}pts — a no-fit task can outscore a real match`
);
