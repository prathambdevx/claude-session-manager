// The routing decision: given a task, pick which existing session should receive it (or say a new
// one should). Reads digests, never transcripts — see routing/digest.ts for why that's affordable.
//
// Two scorers live here and they do different jobs:
//   - heuristicScores(): local, free, instant. Powers the live hint while you type, and the
//     degraded fallback when the model call fails. NOT the decision.
//   - decideRoute(): one Sonnet call. This is the decision, because routing is a judgment call
//     ("which session owns this code path"), not a similarity ranking. Term overlap cannot tell
//     the session that owns checkout totals from the one that owns promo-code parsing; both say
//     "discount". That distinction is exactly what this feature is for.
import { join } from "node:path";
import { PROJECTS_DIR } from "../constants.ts";
import { loadRunning, loadMeta } from "../store.ts";
import { scanAllSessions, projectNameFromCwd } from "../sessions/index.ts";
import { runClaudeHeadless } from "../claude/index.ts";
import { askWarm, warmPoolReady } from "../claude/warmPool.ts";
import { isRoutingRelevantFile } from "../sessions/entries.ts";
import { loadDigest, readRawTail, type RoutingDigest } from "./digest.ts";
import { loadRoutingConfig } from "./config.ts";

/**
 * Recency is a RANKING signal, not a filter. It used to be a hard gate at 24h, which silently made
 * most of the history unroutable: a question about dynamic component imports was answered NONE
 * because the session that owns that architecture was last touched 159h ago and never entered the
 * pool at all. On this machine 24h admitted 5 sessions out of 114.
 *
 * This wider bound exists only to stop the pool growing without limit; evidence decides from there.
 */
export const POOL_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
/**
 * Sessions kept after the cheap prefilter, before digests and tails are read from disk. Also set
 * generously: hydrating all 112 measured at 56ms, because readRawTail seeks to the end of each
 * transcript rather than scanning it, so the I/O this was protecting against does not exist.
 */
/** first-stage recall net — wider than MAX_CANDIDATES on purpose, so an old-but-relevant session
 *  can still surface before the final cut picks the 15 actually sent to Sonnet */
const PREFILTER_KEEP = 40;
/** kept for callers/tests that still refer to the old name — no longer used as a filter */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Cap on candidates handed to the model — a SCALE VALVE, not a relevance filter.
 *
 * Measured on a 112-session corpus, decision quality improves monotonically as this rises and there
 * is no distraction penalty:
 *
 *   cap  P@1   misroute  false-NONE  high-conf
 *    25  75%      3          2          90%
 *    60  90%      2          0         100%
 *   112  90%      0          2         100%
 *
 * So it is set well above any realistic pool: the lexical prefilter's PRECISION contributed nothing,
 * and every routing miss reported during development traced to evidence never reaching the model,
 * not to the model reasoning badly. It still has to exist — a 500-session user would otherwise send
 * 200K+ tokens per route — but at that point its only job is recall: do not drop the answer.
 *
 * 112 over 60 deliberately trades 2 misroutes for 2 false NONEs. Those costs are not equal: a
 * misroute silently drops work into a wrong LIVE session and pollutes its context, whereas a false
 * NONE is visible and one click from correction in the candidate list.
 */
/**
 * Hard cap on candidates sent to Sonnet — the DECIDED design, not a scale valve: keep the wide
 * POOL_WINDOW_MS/PREFILTER_KEEP for recall (an old-but-relevant session must still be reachable),
 * but never build a prompt from more than this many. Set to 15 to match the router's real-world
 * ceiling — a curated "pin an extra session" override was considered and dropped in favor of a
 * fixed automatic cap; see docs/master-session-router.md.
 *
 * Matters more now than it did at 150: MAX_KEPT_CHUNKS=20 and a wider `earlier` make each
 * candidate's prompt block bigger, and 150 candidates x 20 chunks measured an outright CLI crash
 * (E2BIG: argument list too long) well before reaching that combination.
 */
/**
 * Sized to a measured 10s ceiling, not 3-4s — every sweep this session showed 3-4s only holds at
 * ~4-5 candidates, which is too thin for accuracy. Total prompt cost is candidates x chunks/candidate,
 * traded jointly against MAX_KEPT_CHUNKS: see docs/master-session-router.md for the sweep data.
 */
const MAX_CANDIDATES = 8;
/** of MAX_CANDIDATES, how many are awarded on evidence before recency fills the rest */
/** of MAX_CANDIDATES, how many are awarded on evidence before recency fills the rest */
const EVIDENCE_SLOTS = 6;
/** extra prefilter slots reserved for the newest sessions, whatever their evidence */
const RECENCY_SLOTS = 5;

export type RouteCandidate = {
  id: string;
  projectSlug: string;
  label: string;
  project: string;
  cwd: string;
  branch: string | null;
  lastActive: number;
  live: boolean;
  busy: boolean;
  files: string[];
  digest: RoutingDigest | null;
  tail: string;
  score: number; // heuristic 0-1, for the hint and for ranking the list
};

export type RouteDecision = {
  targetId: string | null;
  isNew: boolean;
  suggestedProject: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
};

/** location weights — a token in a file path is far stronger evidence than one in prose */
const FILE_W = 3;
const PROJ_W = 2;
const TEXT_W = 1;
/** raw tail chatter — half of summarised work, since discussing a topic is not owning it */
const CHAT_W = 0.5;
/**
 * Ceiling on one token's location score, and the per-token denominator. Set to file + summary —
 * the realistic best case for a genuine match — so a file-and-summary hit reads as full credit,
 * file-only as 75%, summary-only as 25%.
 */
const MAX_LOC = FILE_W + TEXT_W;
/**
 * Minimum absolute score to claim a match. Replaces a rarity-based gate, which was measured over a
 * task-selected pool and therefore suppressed the very answers the prefilter had surfaced.
 */
const MIN_CLAIMABLE = 0.15;
/**
 * A token counts as discriminative when it appears in at most this FRACTION of the candidates.
 *
 * Relative, not an absolute IDF floor. The previous absolute threshold (0.75) was calibrated on an
 * ~11-candidate pool; once the pool reached 25 the whole IDF scale shifted up and the gate went
 * inert — "index", present in 9 of 25 sessions, cleared it and earned full file weight (3 x 1.01 =
 * 3.03), beating "handler" which appears in exactly one session (2.85 x 1). That is the precise
 * failure the gate was added to prevent. A fraction holds at any corpus size.
 */
const RARE_DF_FRACTION = 0.2;

/**
 * Trailing raw conversation shown per candidate — and therefore also all the tail the heuristic is
 * allowed to score on. Scorer and prompt must weigh the SAME evidence: they were previously
 * mismatched (scorer read the full 1,200 chars, the prompt showed 500), so a session could rank #1
 * — deciding both the candidate cut and the presentation order — on text the decision-maker never
 * saw.
 */
export const EVIDENCE_TAIL_CHARS = 700;

/**
 * FILES ARE NOT TRUNCATED at render time. There is exactly one file limit — the cap in
 * gatherCandidates — so the scorer and the prompt automatically see the same list and cannot drift.
 *
 * A second, smaller render cap (12) caused a confidently-wrong answer: a query about "custom idp in
 * shopify" was answered NONE because idp/provider.ts, auth-v2/idp_handlers.ts and
 * otp_engine/lucent_provider.ts all sat past position 12 of a 40-file list ordered by when files
 * happened to be touched. The model's reasoning was correct for the evidence it received.
 *
 * rankFilesForTask still orders the list by relevance so the model attends to the likely files
 * first, but ordering is now a nicety rather than load-bearing — measured cost of the full list is
 * ~1,043 tokens across 5 candidates (~5,200 at the 25-candidate cap), and input prefill is the
 * cheap half of a call whose latency is ~99.9% model time. Cheap insurance against a hard failure.
 */
export const MAX_CANDIDATE_FILES = 40;

const STOP = new Set([
  "the","a","an","and","or","but","if","then","this","that","these","those","for","from","with","into",
  "to","of","in","on","at","by","is","are","was","were","be","been","it","its","not","no","do","does",
  "did","can","could","should","would","will","when","where","why","how","what","which","our","we","i",
  "my","me","you","your","fix","add","make","update","change","also","need","want","get","use","new",
  // high-frequency engineering verbs/nouns: present in almost every task AND almost every digest,
  // so they contribute noise at best and, before the absolute gate below, manufactured confidence
  "return","handle","improve","reduce","set","check","run","move","rename","support","instead",
  "issue","bug","error","problem","broken","fail","fails","failing","work","working","file","files",
  "code","function","remove","delete","create","implement","refactor","test","tests","proper",
  "properly","correct","correctly","should","just","please","now","still","again","them","they",
  "there","have","has","had","been","being","one","two","three","some","any","all","more","most",
  // URL scaffolding only. An earlier version also stopped path segments — users, desktop, src,
  // apps, index, main, build, app, node, commit, pull, tree, blob, packages, var, private — which
  // deleted real content words: "users" stems to "user", making USER a stopword ("user session
  // expiry" lost its subject), and "the main branch build is failing" reduced to one token.
  // Frequency is IDF's job, not a hand-written list's; only tokens that are never content belong
  // here.
  "http","https","www",
]);

/**
 * Conservative suffix normalization so query and document meet in the middle. Motivating failure:
 * a user typed "microservice" and a session literally named "Microservices" scored 0%.
 *
 * Deliberately not a full Porter stemmer — over-stemming collapses distinct identifiers, and these
 * tokens are largely code nouns where precision matters more than recall ("auth" and "author"
 * must not merge). Only the endings that actually cause plural/tense misses are stripped.
 */
export function stem(t: string): string {
  let w = t;
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y"; // categories -> category
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  // Unify the silent-e family by TRUNCATING both sides rather than restoring a letter:
  // remove/removing/removes/removed -> "remov", size/sizes/sized/sizing -> "siz".
  //
  // An earlier version instead appended "e" after stripping "-ing", which (a) invented letters that
  // were never dropped — loading->"loade", querying->"querye", uploading->"uploade", where "upload"
  // is a real path token here — and (b) applied only to "-ing", desyncing it from "-ed"/"-es" and
  // causing a measured routing regression: "sizing" became "size" while "sizes" became "siz", so a
  // query about the sizing chart stopped matching the session that owns standard_sizes entirely.
  // Truncation can never invent a letter, and treats every inflection the same way.
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  // NO agent-noun (-er/-or) stripping. It was added so "router" and "routing" would meet, and it
  // did — but the collateral was severe: "handler" stems to "handl", which equals stem("handle"),
  // which is in STOP, so the token was DELETED. Same for worker/work, tester/test, checker/check,
  // creator/create. It also merged author/auth, header/head, folder/fold, provider/provide,
  // server/serve. Losing "handler" from a query about idp_handlers costs far more than one
  // meta-query about the router gains.
  return w;
}

/** STOP, run through stem() once, so a stopword is filtered whatever form it arrives in. */
const STOP_STEMMED = new Set([...STOP].map(stem));

function tokens(s: string): string[] {
  // camelCase splitting destroys short acronyms before the length filter sees them: "IdP" becomes
  // "id" + "p", both dropped as <=2 chars, so a query of just "IdP" produced ZERO tokens. Keep the
  // unsplit lowercase form for short mixed-case words so acronyms survive alongside the split ones.
  // Only for words the normal path would LOSE entirely. Emitting both forms unconditionally
  // double-counted: "gRPC" produced grpc + rpc, so total became 2, need=2 became unsatisfiable,
  // and a file named grpc_client.ts matched 1/2 and displayed 0% where one token gave 75%.
  const acronyms = (s.match(/\b[A-Za-z]{2,5}\b/g) ?? [])
    .filter((w) => /[a-z]/.test(w) && /[A-Z]/.test(w) && w.length > 2)
    .filter((w) => {
      const split = (w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) || []).filter(
        (t) => t.length > 2
      );
      return split.length === 0; // the split threw it away — keep the whole form instead
    })
    .map((w) => w.toLowerCase());

  const split = (
    s
      // Split camelCase/PascalCase BEFORE lowering. Lowering first destroys the case boundary, so
      // `useWishlist.ts` tokenized to `usewishlist` and the token `wishlist` never existed at all —
      // silently killing the file-path signal.
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  )
    .filter((t) => t.length > 2 && !STOP.has(t))
    .map(stem)
    // second pass: "testing"/"returning"/"creating" only become stopwords after stemming
    .filter((t) => t.length > 2 && !STOP_STEMMED.has(t));

  return [...acronyms.map(stem), ...split];
}

/**
 * Local relevance score per candidate. File-path overlap is weighted hardest because `files` is
 * whole-session and precise — a task naming a real symbol/path is strong evidence, where prose
 * overlap is mostly topical noise.
 */
export type HeuristicScore = {
  /** 0-1 weighted evidence, absolute and gated — this is what the UI shows */
  score: number;
  /**
   * The same evidence WITHOUT the absolute gate. Used only for ranking and for the MAX_CANDIDATES
   * cut: the gate exists so the UI can't claim "27% confident" on a task that fits nothing, but it
   * zeroes near-miss candidates too, and a zeroed candidate then sorts by recency alone. Since the
   * cut happens after that sort, a display concern was deciding what the model could ever see.
   */
  rawScore: number;
  /** how many distinct query tokens matched anywhere, and how many were in play */
  matched: number;
  total: number;
};

/**
 * Local, model-free relevance. Powers the live hint while typing and the degraded fallback when the
 * model call fails — it is NOT the routing decision (see decideRoute).
 */
export function heuristicDetail(task: string, candidates: RouteCandidate[]): Map<string, HeuristicScore> {
  const q = [...new Set(tokens(task))];
  const out = new Map<string, HeuristicScore>();
  const zero = { score: 0, rawScore: 0, matched: 0, total: q.length };
  if (!q.length || !candidates.length) {
    for (const c of candidates) out.set(c.id, zero);
    return out;
  }

  const sets = candidates.map((c) => ({
    id: c.id,
    file: new Set(tokens(c.files.join(" "))),
    proj: new Set(tokens(c.project + " " + (c.branch ?? ""))),
    // the human-given session name, scored like project: naming a session by name should reach it
    label: new Set(tokens(c.label)),
    // summarised WORK — what the session demonstrably built
    // label deliberately NOT included here — it has its own set above. Counting it in both gave a
    // session named "cart totals discount rewrite" 75% on "discount cart" with zero files and zero
    // digest, purely from its name.
    text: new Set(
      tokens(
        [c.digest?.earlier ?? "", ...(c.digest?.chunks ?? []).flatMap((k) => [k.summary, k.topics ?? ""])].join(" ")
      )
    ),
    // raw recent CHATTER, scored lower: a session merely discussing a topic quotes its vocabulary
    // without owning any of it, and the router's own session quotes every task typed into the UI
    chat: new Set(tokens(c.tail.slice(-EVIDENCE_TAIL_CHARS))),
  }));

  // IDF over the candidate set: a token in every session ("production", "src", "apps") identifies
  // nothing, one in a single session ("wishlist", "msg91") identifies it exactly.
  const N = candidates.length;
  const idf = new Map<string, number>();
  const isRare = new Map<string, boolean>();
  const rareMax = Math.max(1, Math.ceil(N * RARE_DF_FRACTION));
  for (const t of q) {
    let df = 0;
    // chat is EXCLUDED from df: sessions that merely mention a token inflated its document
    // frequency and demoted the true owner (measured 75% -> 25%), and the router's own session
    // quotes every task typed into the UI, so it was a guaranteed contributor.
    for (const s of sets) if (s.file.has(t) || s.proj.has(t) || s.label.has(t) || s.text.has(t)) df++;
    idf.set(t, df === 0 ? 0 : Math.max(0, Math.log(1 + (N - df + 0.5) / (df + 0.5))));
    isRare.set(t, df > 0 && df <= rareMax);
  }

  // Denominator spans EVERY query token, not only the ones that happen to appear somewhere. An
  // earlier version used matchable-only, which quietly handed the decision to a query's incidental
  // words whenever its real content words were out-of-vocabulary: "two shoppers hitting the basket
  // concurrently get a gateway error" collapsed to {two, gateway, error} and a Java-onboarding
  // session won on "two". Spanning all tokens keeps a poorly-covered query honestly low instead.
  // Weight assumed for a query token absent from the corpus. Set at/above a typical rare-token idf
  // so unmatched content words genuinely cost coverage — too low and a single lucky hit on a
  // six-word task still read as a confident match.
  const IDF_UNKNOWN = 2.2;
  // MAX_LOC, not FILE_W: `loc` sums across locations and could reach FILE_W+PROJ_W+TEXT_W, i.e.
  // TWICE a token's share of a FILE_W-based denominator. Scores clamped at 1.0 and produced
  // multi-way ties broken by recency — "wishlist" tied four sessions at 100% and picked the wrong
  // one. Numerator and denominator must use the same ceiling.
  const perfect = q.reduce((a, t) => a + ((idf.get(t) ?? 0) || IDF_UNKNOWN) * MAX_LOC, 0);

  for (const s of sets) {
    let term = 0;
    let matched = 0;
    let rareMatches = 0;
    let rareFileMatch = false;
    for (const t of q) {
      const w = idf.get(t) ?? 0;
      if (w <= 0) continue;
      const inFile = s.file.has(t);
      const inProj = s.proj.has(t) || s.label.has(t);
      const inText = s.text.has(t);
      const inChat = s.chat.has(t);
      if (!inFile && !inProj && !inText && !inChat) continue;
      matched++;
      // Rarity GATES the location weight rather than merely multiplying it. Otherwise a ubiquitous
      // path segment cleared the bar on file weight alone — "test" (df=6, idf 0.61) x3 = 1.83 beat
      // a genuinely distinctive prose token at idf 2.08 x1.
      const rare = isRare.get(t) === true;
      if (rare) {
        rareMatches++;
        if (inFile) rareFileMatch = true;
      }
      // a chat-only match contributes score but is not corroboration
      if (!inFile && !inProj && !inText) { term += w * CHAT_W; continue; }
      let loc = 0;
      if (inFile) loc += rare ? FILE_W : 1;
      if (inProj) loc += rare ? PROJ_W : 0.5;
      if (inText) loc += TEXT_W;
      else if (inChat) loc += CHAT_W;
      term += w * Math.min(loc, MAX_LOC);
    }

    // Absolute evidence gate. Ratio scoring alone can never express "no candidate fits", so
    // "refactor this to be more maintainable and add tests" used to read 63% confident. Require
    // either two distinct rare-token matches, or one rare token matched in an actual file path.
    // One matched term is never sufficient evidence, however rare it is or wherever it appeared:
    // "add a dark mode toggle to the marketing site footer" hit a single rare token in some file
    // path and read 27% on 1-of-6 coverage. Require corroboration.
    const raw = term === 0 ? 0 : Math.min(1, term / perfect);

    // The gate deliberately does NOT depend on document frequency.
    //
    // It used to require rare-token matches, and rarity is measured over the candidate pool — a
    // pool that gatherCandidates selects BY THE TASK. That made the gate self-defeating: the better
    // the prefilter concentrated matching sessions, the higher df climbed, the more tokens flipped
    // from rare to common, and the more the gate zeroed the correct answer. Measured on the real
    // path: "otp" went df 5/25 (shown 100%) in a neutral pool to df 14/25 (shown 0.0%) in the
    // task-ranked pool, and "msg91 otp" zeroed all 25 candidates including the session named Msg91.
    //
    // An absolute score floor expresses the same intent — "is there enough evidence to claim a
    // match?" — without any dependence on which other candidates happen to be in the pool.
    const need = Math.min(2, q.length);
    const enough = matched >= need && raw >= MIN_CLAIMABLE;
    out.set(s.id, { score: enough ? raw : 0, rawScore: raw, matched, total: q.length });
  }
  return out;
}

/** Back-compat shape used by the sort and the degraded fallback. */
export function heuristicScores(task: string, candidates: RouteCandidate[]): Map<string, number> {
  const detail = heuristicDetail(task, candidates);
  return new Map([...detail].map(([id, d]) => [id, d.score]));
}

/**
 * Put files whose path tokens appear in the task first, preserving original order within each
 * group. Cheap (the token sets are tiny) and it is what makes the EVIDENCE_FILES truncation safe.
 */
function rankFilesForTask(files: string[], taskTokens: Set<string>): string[] {
  if (!taskTokens.size) return files;
  const hit: string[] = [];
  const miss: string[] = [];
  for (const f of files) {
    (tokens(f).some((t) => taskTokens.has(t)) ? hit : miss).push(f);
  }
  return [...hit, ...miss];
}

/**
 * TEMPORARY test pin — when non-empty, gatherCandidates returns ONLY these session ids (by prefix),
 * skipping the normal eligibility window, prefilter, and MAX_CANDIDATES cut entirely. Added to get
 * a controlled 5-candidate test bed (Lucentt, Strapi blocks, Microservices, Production Module,
 * Review Migration) back to a ~3-4s decision while their digests are being validated. Clear this
 * array (or delete this block) to return to normal automatic candidate gathering.
 */
const DEBUG_PINNED_SESSION_IDS: string[] = [
  "b4a1eeb1", // Lucentt
  "c1142cbe", // Strapi blocks
  "28bf1e94", // Microservices
  "8472de80", // Production Module
  "40a10c23", // Review Migration
];

export async function gatherCandidates(task = ""): Promise<RouteCandidate[]> {
  const taskTokens = new Set(tokens(task));
  const [sessions, running, meta, cfg] = await Promise.all([
    scanAllSessions(),
    loadRunning(),
    loadMeta(),
    loadRoutingConfig(),
  ]);
  const shell = (s: (typeof sessions)[number]): RouteCandidate => {
    const m = meta[s.id] ?? {};
    const r = running[s.id] ?? null;
    return {
      id: s.id,
      projectSlug: s.projectSlug,
      label: m.name || m.description || s.firstMessage || "(untitled)",
      project: projectNameFromCwd(s.cwd),
      cwd: s.cwd,
      branch: s.gitBranch,
      lastActive: s.lastActive,
      live: !!r,
      busy: r?.status === "busy",
      files: rankFilesForTask(s.changedFiles.filter(isRoutingRelevantFile), taskTokens),
      digest: null,
      tail: "",
      score: 0,
    };
  };

  if (DEBUG_PINNED_SESSION_IDS.length) {
    const pinned = sessions.filter((s) => DEBUG_PINNED_SESSION_IDS.some((p) => s.id.startsWith(p)));
    const shells = pinned.map(shell);
    const hydrated = await Promise.all(
      shells.map(async (c) => {
        let digest = null;
        try { digest = await loadDigest(c.id); } catch { digest = null; }
        const tail = await readRawTail(join(PROJECTS_DIR, c.projectSlug, `${c.id}.jsonl`), digest?.coveredBytes ?? 0);
        return {
          ...c,
          digest,
          tail,
          files: rankFilesForTask(
            [...new Set([...(digest?.files ?? []), ...c.files])].filter(isRoutingRelevantFile),
            taskTokens
          ).slice(0, MAX_CANDIDATE_FILES),
        };
      })
    );
    const detail = heuristicDetail(task, hydrated);
    for (const c of hydrated) c.score = detail.get(c.id)?.score ?? 0;
    return hydrated;
  }

  const excluded = new Set(cfg.excludedProjects);
  const cutoff = Date.now() - POOL_WINDOW_MS;

  const eligible = sessions.filter((s) => {
    const m = meta[s.id] ?? {};
    if (m.archived) return false;
    if (excluded.has(projectNameFromCwd(s.cwd))) return false;
    // Liveness from ~/.claude/sessions/*.json is known to lag, so it only ever ADDS a candidate.
    return !!running[s.id] || s.lastActive >= cutoff;
  });

  // ---- Phase 1: cheap prefilter. Scores only what scanAllSessions already gave us — label,
  // project, branch and changed files — with no digest read and no tail read. That matters: a tail
  // read touches ~600KB per session, so hydrating all 114 up front would be ~68MB of I/O on an
  // endpoint that fires on a typing debounce.
  const shells = eligible.map(shell);
  const preDetail = heuristicDetail(task, shells);
  const preRanked = [...shells].sort(
    (a, b) =>
      (preDetail.get(b.id)?.rawScore ?? 0) - (preDetail.get(a.id)?.rawScore ?? 0) ||
      Number(b.live) - Number(a.live) ||
      b.lastActive - a.lastActive
  );
  const keep = new Map<string, RouteCandidate>();
  for (const c of preRanked.slice(0, PREFILTER_KEEP)) keep.set(c.id, c);
  // Reserve slots for the most recent sessions regardless of evidence, so a session too new to have
  // any digest or file history can still be chosen.
  for (const c of [...shells].sort((a, b) => b.lastActive - a.lastActive)) {
    if (keep.size >= PREFILTER_KEEP + RECENCY_SLOTS) break;
    keep.set(c.id, c);
  }

  // ---- Phase 2: hydrate only the survivors with their digest and live tail.
  const hydrated = await Promise.all(
    [...keep.values()].map(async (c) => {
      let digest = null;
      try {
        digest = await loadDigest(c.id);
      } catch {
        digest = null; // corrupt digest: route on files + tail rather than failing the request
      }
      const tail = await readRawTail(join(PROJECTS_DIR, c.projectSlug, `${c.id}.jsonl`), digest?.coveredBytes ?? 0);
      return {
        ...c,
        digest,
        tail,
        files: rankFilesForTask(
          [...new Set([...(digest?.files ?? []), ...c.files])].filter(isRoutingRelevantFile),
          taskTokens
        ).slice(0, MAX_CANDIDATE_FILES),
      };
    })
  );

  // ---- Phase 3: full score with digests, then the final cut.
  const detail = heuristicDetail(task, hydrated);
  for (const c of hydrated) c.score = detail.get(c.id)?.score ?? 0;
  const byEvidence = [...hydrated].sort(
    (a, b) =>
      (detail.get(b.id)?.rawScore ?? 0) - (detail.get(a.id)?.rawScore ?? 0) ||
      Number(b.live) - Number(a.live) ||
      b.lastActive - a.lastActive
  );
  if (byEvidence.length <= MAX_CANDIDATES) return byEvidence;

  const chosen: RouteCandidate[] = [];
  const seen = new Set<string>();
  for (const c of byEvidence.slice(0, EVIDENCE_SLOTS)) {
    chosen.push(c);
    seen.add(c.id);
  }
  for (const c of [...hydrated].sort((a, b) => b.lastActive - a.lastActive)) {
    if (chosen.length >= MAX_CANDIDATES) break;
    if (!seen.has(c.id)) {
      chosen.push(c);
      seen.add(c.id);
    }
  }
  return chosen;
}

/**
 * Every kept chunk is rendered. A cap of 3 here silently hid evidence exactly as the old 12-file cap
 * did: a session with 5 chunks had its first two dropped, and since MAX_KEPT_CHUNKS is also 5,
 * nothing had been folded into `earlier` either — so that work was invisible to the model with no
 * indication anything was missing. The list is already bounded by MAX_KEPT_CHUNKS (5 short lines),
 * so there is nothing to gain by cutting it further.
 */

function renderCandidate(c: RouteCandidate, i: number): string {
  const lines = [
    `${i + 1}. ${c.label.slice(0, 110)}`,
    `   project: ${c.project}${c.branch ? ` | branch: ${c.branch}` : ""}${c.busy ? " | BUSY (mid-turn)" : ""}${c.live ? " | live" : ""}`,
  ];
  if (c.digest?.earlier) lines.push(`   earlier: ${c.digest.earlier.replace(/\n+/g, " ")}`);
  for (const k of c.digest?.chunks ?? []) lines.push(`   did: ${k.summary.replace(/\n+/g, " ")}`);
  // the alias terms — they let the model connect "basket" to a session that only says "cart"
  const topics = (c.digest?.chunks ?? []).map((k) => k.topics).filter(Boolean).join("; ");
  if (topics) lines.push(`   topics: ${topics.slice(0, 300)}`);
  // "touched", not "owns": this is every file the session edited, for any reason. Calling it
  // "owns" asserted the very thing the prompt then asks the model to judge for itself.
  if (c.files.length) {
    const rel = c.files.map((f) => (c.cwd && f.startsWith(c.cwd + "/") ? f.slice(c.cwd.length + 1) : f));
    lines.push(`   touched: ${rel.join(", ")}`);
  }
  // Only a live session has a "right now" — labelling a 20h-old tail that way is just wrong.
  //
  // Measured worth: withholding this single line drops decision P@1 from 90% to 75% and takes
  // misroutes from 0 to 2. That is a large effect from a small amount of text, and it only appears
  // for the handful of LIVE sessions — the reason being that digest coverage on big sessions is
  // thin (8-19%), so the summaries simply do not describe recent work yet. The raw tail is the only
  // un-summarised, never-stale evidence in the prompt, and the only evidence at all for a session
  // with no digest.
  if (c.tail && c.live) lines.push(`   right now: ${c.tail.replace(/\n+/g, " ").slice(-EVIDENCE_TAIL_CHARS)}`);
  return lines.join("\n");
}

/** Deterministic order shuffle, seeded by the task, so the heuristic's ranking cannot act as a
 *  positional anchor for the model while still being reproducible for the same task. */
function seededOrder(n: number, seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = ((h ^ seed.charCodeAt(i)) * 16777619) >>> 0;
  const idx = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const j = h % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

export async function decideRoute(task: string, candidates: RouteCandidate[], knownProjects: string[]): Promise<RouteDecision> {
  // Present in shuffled order: gatherCandidates sorts by heuristic score, so without this the
  // model's first entry is a systematically biased anchor produced by a scorer that is explicitly
  // blind to code-path ownership. `order[i]` maps a displayed number back to the real candidate.
  const order = seededOrder(candidates.length, task);
  const shown = order.map((i) => candidates[i]);
  const listing = shown.map(renderCandidate).join("\n\n");

  const prompt =
    `A developer needs to hand off this task:\n"${task}"\n\n` +
    `Below are their open or recently-active coding sessions. THE ORDER IS ARBITRARY — it carries ` +
    `no ranking. Judge each on its own evidence; do not prefer earlier entries.\n\n${listing}\n\n` +
    `Decide which ONE session already OWNS THE CODE PATH this task would change — or answer NONE.\n\n` +
    `Ownership is not topical similarity and not file overlap. A session that edited a file for a ` +
    `different purpose does not own a new concern in that file: a session refactoring products.ts ` +
    `for inventory APIs does not own "product cards render blank". Two sessions can both say ` +
    `"discount" while one owns totals math and the other promo-code parsing. Ask: would this ` +
    `work land inside what this session is already mid-way through?\n\n` +
    `A session that merely MENTIONS or DISCUSSES the task does not own it. "right now:" text is ` +
    `raw recent transcript, so a session that was talking about this topic — including one that was ` +
    `being asked to route it, or discussing the router itself — will quote it back verbatim. Quoting ` +
    `is not ownership. Ownership means the session has been building or debugging the actual code ` +
    `involved, which shows up in "did:" and "touched:", not in chatter.\n\n` +
    `The handoff may be a QUESTION rather than a change ("can X cause Y?", "how does Z work?", ` +
    `"tell me about our W"). Questions are routable and often should be routed: the right owner is ` +
    `the session already holding the context to answer it, even though answering produces no diff. ` +
    `Do not answer NONE merely because nothing would be edited.\n\n` +
    `NONE is a first-class, frequently-correct answer, not a fallback. Most tasks belong to no open ` +
    `session. Choose a session only if you can name the specific ongoing work the task continues. ` +
    `A BUSY session is a valid choice.\n\n` +
    `Known projects (only used when the answer is NONE): ${knownProjects.join(", ") || "(none)"}\n\n` +
    `Reply in exactly this format. Plain text, no markdown, no bold, no extra lines.\n\n` +
    `EVIDENCE: <one sentence: the strongest fact for your pick>\n` +
    `AGAINST: <one sentence: the best case for a different answer, or for NONE>\n` +
    `TARGET: <candidate number> or NONE\n` +
    `CONFIDENCE: high | medium | low\n` +
    `   high   = a specific ongoing thread in that session plainly continues into this task\n` +
    `   medium = plausible owner, but another session or NONE is defensible\n` +
    `   low    = mostly a guess\n` +
    `PROJECT: <one project name from the list above, only when TARGET is NONE; otherwise write none>\n` +
    `REASON: <one sentence, single line>`;

  // Warm standby when ready (measured 3.1x faster end to end), cold spawn otherwise. The cold path
  // is always correct, so a missing or broken pool only costs speed.
  let out: string;
  try {
    out = warmPoolReady()
      ? await askWarm(prompt, 60_000)
      : await runClaudeHeadless(prompt, { tools: "", model: "sonnet", timeoutMs: 45_000 });
  } catch {
    out = await runClaudeHeadless(prompt, { tools: "", model: "sonnet", timeoutMs: 45_000 });
  }

  // Tolerate markdown decoration: a "**TARGET:** 3" answer used to fail the anchor outright.
  const grab = (key: string) => out.match(new RegExp(`^\\s*[*#>\\-\\s]*${key}\\s*:?\\**\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";
  const targetRaw = grab("TARGET").replace(/\*+/g, "").trim();
  const confRaw = grab("CONFIDENCE").toLowerCase();
  const projRaw = grab("PROJECT").replace(/[*<>]/g, "").trim();
  const evidence = grab("EVIDENCE");
  const reason = (grab("REASON") || evidence || "no reason given").slice(0, 300);

  const confidence: RouteDecision["confidence"] =
    confRaw.startsWith("high") ? "high" : confRaw.startsWith("med") ? "medium" : "low";

  // Accept NONE as well as NEW. Previously only /^new\b/ matched, so a "TARGET: NONE" answer had
  // no digit either and fell through to the "no usable answer" branch — reporting a parse failure
  // for what was actually a clean, correct decision.
  if (/^(none|new|no\b)/i.test(targetRaw)) {
    const cleaned = projRaw.toLowerCase();
    const suggested =
      cleaned && cleaned !== "none" && cleaned !== "-"
        ? knownProjects.find((p) => p.toLowerCase() === cleaned) ?? null
        : null;
    return { targetId: null, isNew: true, suggestedProject: suggested, confidence, reason };
  }
  const n = parseInt((targetRaw.match(/\d+/) || [])[0] ?? "", 10);
  const hit = Number.isFinite(n) ? shown[n - 1] : undefined;
  if (!hit) {
    // unparseable — surface it as an honest low-confidence non-decision rather than silently
    // defaulting to candidate 1, which would look like a real choice
    return { targetId: null, isNew: false, suggestedProject: null, confidence: "low", reason: "router gave no usable answer" };
  }
  return { targetId: hit.id, isNew: false, suggestedProject: null, confidence, reason };
}
