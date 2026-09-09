// Accuracy harness for the ROUTING DECISION — the Sonnet call in decideRoute, which is what
// actually decides. Distinct from eval-routing.ts, which only measures the lexical prefilter.
//
//   bun backend/scripts/eval-decision.ts            # all cases
//   bun backend/scripts/eval-decision.ts 6          # first 6 only (cheaper iteration)
//
// Spends one model call per case (~3s warm), so a full run is ~25 calls. Reports four things that
// matter separately:
//   P@1            - picked the right session
//   MISROUTE       - picked a DIFFERENT session (worst outcome: work lands in the wrong context)
//   FALSE NONE     - said NONE when a real owner existed (the failure mode seen most often by hand)
//   NONE precision - said NONE when NONE was genuinely correct
// Confidence is reported per bucket, because a confidence label is only useful if "high" is
// measurably more accurate than "medium".
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { DATA_DIR } from "../src/constants.ts";
import { gatherCandidates, decideRoute } from "../src/routing/decide.ts";
import { scanAllSessions, projectNameFromCwd } from "../src/sessions/index.ts";
import { loadMeta } from "../src/store.ts";
import { startWarmPool, warmPoolReady, stopWarmPool } from "../src/claude/warmPool.ts";

const limit = Number(process.argv[2] ?? 0);
const spec = JSON.parse(await readFile(join(DATA_DIR, "routing-eval.json"), "utf-8"));
const meta = await loadMeta();
const projects = [...new Set((await scanAllSessions()).map((s) => projectNameFromCwd(s.cwd)))];

const cases: { q: string; want: string | null }[] = [
  ...spec.cases.map((c: any) => ({ q: c.q, want: c.want as string })),
  ...spec.noFit.map((q: string) => ({ q, want: null })),
];
const run = limit > 0 ? cases.slice(0, limit) : cases;

// warm the standby so each case pays ~3s rather than ~10s
startWarmPool("sonnet");
for (let i = 0; i < 40 && !warmPoolReady(); i++) await Bun.sleep(500);

const name = (id: string | null) => (id ? meta[id]?.name || id.slice(0, 8) : "NONE");
let right = 0, misroute = 0, falseNone = 0, noneRight = 0, noneWrong = 0;
const byConf: Record<string, { n: number; ok: number }> = {};

for (const { q, want } of run) {
  const cands = await gatherCandidates(q);
  let verdict: string, ok: boolean;
  try {
    const d = await decideRoute(q, cands, projects);
    const picked = d.targetId;
    const conf = d.confidence;
    byConf[conf] ??= { n: 0, ok: 0 };
    byConf[conf].n++;

    if (want === null) {
      ok = picked === null;
      if (ok) noneRight++; else noneWrong++;
      verdict = ok ? "NONE ok" : `NONE MISSED -> ${name(picked)}`;
    } else if (picked === null) {
      ok = false;
      falseNone++;
      verdict = `FALSE NONE (wanted ${want.slice(0, 8)})`;
    } else if (picked.startsWith(want)) {
      ok = true;
      right++;
      verdict = "correct";
    } else {
      ok = false;
      misroute++;
      verdict = `MISROUTE -> ${name(picked)} (wanted ${want.slice(0, 8)})`;
    }
    if (ok) byConf[conf].ok++;
    // whether the right answer was even reachable — separates recall failures from judgement ones
    const reachable = want === null || cands.some((c) => c.id.startsWith(want));
    console.log(
      `${ok ? "PASS" : "FAIL"} ${conf.padEnd(6)} ${reachable ? "  " : "!!"} ${verdict.padEnd(42)} ${q.slice(0, 46)}`
    );
    if (!reachable) console.log(`      ^ target was NOT in the candidate set — a recall failure, not a judgement failure`);
  } catch (e: any) {
    console.log(`ERR  ${String(e?.message).slice(0, 40).padEnd(56)} ${q.slice(0, 46)}`);
  }
}
stopWarmPool();

const labelled = run.filter((c) => c.want !== null).length;
const noFit = run.length - labelled;
console.log(`\n--- decisions on ${labelled} labelled cases ---`);
console.log(`P@1            : ${right}/${labelled} = ${labelled ? ((right / labelled) * 100).toFixed(0) : 0}%`);
console.log(`MISROUTE       : ${misroute}  (picked the wrong session)`);
console.log(`FALSE NONE     : ${falseNone}  (said NONE when an owner existed)`);
if (noFit) console.log(`--- ${noFit} no-fit cases ---\nNONE correct   : ${noneRight}/${noFit}   invented an owner: ${noneWrong}`);
console.log(`\nconfidence calibration (is "high" actually better?)`);
for (const [c, v] of Object.entries(byConf)) {
  console.log(`  ${c.padEnd(7)} n=${String(v.n).padStart(2)}  accurate ${v.ok}/${v.n} = ${((v.ok / v.n) * 100).toFixed(0)}%`);
}
