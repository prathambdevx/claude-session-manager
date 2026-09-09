// Best-effort auto-heal for a moved project folder: when a session's recorded cwd is missing,
// search common dev-folder roots for a same-named directory. Real symlinks (Dirent.isDirectory()
// is false for them) are never followed, so this can't loop through the very aliases it creates.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "../constants.ts";

// Skipped by name at any depth — dependency/build trees dwarf real project folders in size and
// are never themselves a project root worth matching.
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "build", ".next", "target", "venv", ".venv", "__pycache__", "vendor"]);
// Scoped to where dev work actually lives — walking all of $HOME would crawl Library/ (huge,
// unbounded) and block a request for many seconds; confirmed live via a route-test timeout.
const SEARCH_ROOTS = ["Desktop", "Documents", "Developer", "dev", "Projects", "code", "workspace"];
const MAX_DEPTH = 4;

async function walk(root: string, targetLower: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_DEPTH || found.length > 1) return; // stop early once ambiguous
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.name.toLowerCase() === targetLower) found.push(full);
    if (found.length > 1) return;
    await walk(full, targetLower, depth + 1, found);
    if (found.length > 1) return;
  }
}

/** Returns every directory under `root` (case-insensitive name match), stopping early past 1 match — callers only ever want a unique hit. */
export async function findCandidatesUnder(root: string, basenameLower: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, basenameLower, 0, found);
  return found;
}

export async function findCandidatesForBasename(name: string): Promise<string[]> {
  const targetLower = name.toLowerCase();
  const found: string[] = [];
  for (const rel of SEARCH_ROOTS) {
    const root = join(HOME, rel);
    if (!existsSync(root)) continue;
    await walk(root, targetLower, 0, found);
    if (found.length > 1) break;
  }
  return found;
}
