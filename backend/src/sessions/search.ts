// Keyword + snippet search over transcripts — powers both the quick keyword search and the
// Claude-ranked smart search (which calls keywordSearchScores first to shortlist candidates).
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR } from "../constants.ts";
import { NOISE_MESSAGE, firstTextFromContent } from "./shared.ts";

const STOPWORDS = new Set([
  "the","a","an","this","that","these","those","is","was","were","are","be","been","being",
  "and","or","to","in","on","for","with","of","had","has","have","having","so","no","not",
  "it","its","as","like","i","im","was","able","just","also","then","than","there","here",
  "where","when","what","which","who","whom","do","does","did","done","can","could","would",
  "should","will","shall","may","might","must","we","you","your","my","me","us","our","they",
  "them","their","he","she","him","her","but","if","because","while","from","into","out","up",
  "down","over","under","again","once","some","any","all","each","other","such","only","own",
  "same","very","too","one",
]);

// words that describe the act of searching, not the thing being searched for — they'd match
// everything and drown out the meaningful terms, so drop them from the query needles
const SEARCH_MECHANICS = new Set([
  "find","found","search","searching","looking","look","session","sessions","chat","conversation",
  "remember","recall","refactored","refactor","earlier","previous","past","worked","working","did","made",
]);

export function queryNeedles(rawQuery: string, dropMechanics = false): string[] {
  const tokens = [
    ...new Set(
      rawQuery
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !(dropMechanics && SEARCH_MECHANICS.has(t)))
    ),
  ];
  return tokens.length ? tokens : [rawQuery];
}

// Pull the most-relevant snippets from a transcript: score every message by how many DISTINCT query
// terms it contains and return the densest ones (user messages weighted higher — the human's own
// request is the strongest signal), so a pivotal line deep in a huge session surfaces instead of
// whatever generic mention happens to appear first.
export async function matchSnippets(
  filePath: string,
  needles: string[],
  maxSnippets = 5
): Promise<{ snippets: string[]; density: number }> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch {
    return { snippets: [], density: 0 };
  }
  const scored: { score: number; snippet: string }[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const isUser = d.type === "user";
    let content: string | null = null;
    if (isUser && d.message?.content && !d.isMeta) content = firstTextFromContent(d.message.content);
    else if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      const textBlock = d.message.content.find((b: any) => b?.type === "text" && b.text?.trim());
      content = textBlock?.text ?? null;
    }
    if (!content || NOISE_MESSAGE.test(content.trim())) continue;
    const lower = content.toLowerCase();
    const hits = needles.filter((n) => lower.includes(n));
    if (!hits.length) continue;
    const firstHit = Math.min(...hits.map((n) => lower.indexOf(n)));
    const start = Math.max(0, firstHit - 100);
    const snippet = content.slice(start, start + 300).replace(/\s+/g, " ").trim();
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    // co-occurrence in a single message is the signal — terms together in one line beat the same
    // terms scattered across a session. USER messages get a big boost: a search like "the session
    // where I did X" is recalling the human's own request, which lives in a user turn — so a user
    // line with 2 matching terms should outrank an assistant status line that happens to have 3
    // (and this survives the user's typos/word-variants that keyword matching alone would miss).
    const score = hits.length + (isUser ? 2 : 0);
    scored.push({ score, snippet: `${isUser ? "USER" : "ASSISTANT"}: ${snippet}` });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    snippets: scored.slice(0, maxSnippets).map((s) => s.snippet),
    density: scored.length ? scored[0].score : 0,
  };
}

export async function keywordSearchScores(rawQuery: string, matchRatio: number): Promise<Record<string, number>> {
  const needles = queryNeedles(rawQuery);
  const minMatches = Math.min(needles.length, Math.max(1, Math.ceil(needles.length * matchRatio)));
  const scores: Record<string, number> = {};
  if (!existsSync(PROJECTS_DIR)) return scores;
  const projectDirs = await readdir(PROJECTS_DIR);
  await Promise.all(
    projectDirs.map(async (slug) => {
      const dir = join(PROJECTS_DIR, slug);
      let files: string[] = [];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return;
      }
      await Promise.all(
        files.map(async (f) => {
          try {
            const text = (await readFile(join(dir, f), "utf-8")).toLowerCase();
            const matched = needles.filter((n) => text.includes(n)).length;
            if (matched >= minMatches) scores[f.replace(/\.jsonl$/, "")] = matched;
          } catch {
            // unreadable transcript — skip
          }
        })
      );
    })
  );
  return scores;
}
