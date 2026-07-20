// Whether a session's cwd looks like a real project — used to keep scratch/temp directories from
// auto-seeding their own "Projects" column (see mergeInProjectColumns in the frontend). A session
// itself is never hidden by this; it only gates automatic project-column creation.
import { readdir } from "node:fs/promises";
import { dirname } from "node:path";

// macOS's OS-level scratch space — sessions run here are almost always one-off manual testing,
// never a real project a user wants tracked as one.
const SCRATCH_PREFIXES = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

// .git is the strongest, language-agnostic signal. The rest cover the common project types by
// their package/build manifest, so this recognizes a real project regardless of stack — JS/TS
// (incl. React, Next.js, React Native), mobile (iOS/Android/Flutter), and most backend languages.
const PROJECT_MARKERS = new Set([
  ".git",
  "package.json", // Node/JS/TS — also covers React, Next.js, React Native, Vue, Svelte, Angular
  "Cargo.toml", // Rust
  "go.mod", // Go
  "pyproject.toml", "setup.py", "requirements.txt", "Pipfile", // Python
  "Gemfile", // Ruby / Rails
  "composer.json", // PHP
  "pom.xml", "build.gradle", "build.gradle.kts", // Java / Kotlin / Android
  "pubspec.yaml", // Flutter / Dart
  "Podfile", // iOS (CocoaPods)
  "mix.exs", // Elixir
  "CMakeLists.txt", "Makefile", // C / C++
  ".claude", // a project already configured for Claude Code, even with no other marker
]);

function hasXcodeProject(entries: string[]): boolean {
  return entries.some((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
}

function hasDotnetProject(entries: string[]): boolean {
  return entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"));
}

async function hasProjectMarkers(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.some((e) => PROJECT_MARKERS.has(e)) || hasXcodeProject(entries) || hasDotnetProject(entries);
  } catch {
    return false; // unreadable/missing — treat as not a project rather than throw
  }
}

// A session's cwd is often a sub-package of a monorepo (e.g. apps/frontend) with no manifest of
// its own — the real markers sit at the repo root a few levels up. Capped so an unrelated marker
// file sitting near home/`/` can't make every session look like a project.
const MAX_ANCESTOR_DEPTH = 5;

// One walk-up per distinct cwd, cached for the process lifetime — a directory's project-ness
// essentially never changes mid-session, so there's no need to re-stat it on every poll.
const cache = new Map<string, boolean>();

export async function isLikelyProjectDir(cwd: string): Promise<boolean> {
  if (SCRATCH_PREFIXES.some((p) => cwd.startsWith(p))) return false;
  const cached = cache.get(cwd);
  if (cached != null) return cached;
  let result = false;
  let dir = cwd;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    if (await hasProjectMarkers(dir)) { result = true; break; }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  cache.set(cwd, result);
  return result;
}
