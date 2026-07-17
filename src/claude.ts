// Everything that shells out to the `claude` CLI or the macOS Terminal: headless one-shot calls,
// launching interactive sessions in a new Terminal window, reusing an existing tab, and the prompt
// builders for the launcher / reviewer / context-extraction / continuation flows.
import { chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { HOME, CLAUDE_BIN, KNOWN_MODELS, DANGEROUS_FLAG, EFFORT_FLAG, EXTENDED_CONTEXT } from "./config.ts";
import { pidAlive } from "./store.ts";
import type { ReviewRecord, ContextRecord, Agent } from "./store.ts";

// ---------- headless one-shot ----------

export function runClaudeHeadless(
  prompt: string,
  opts: { timeoutMs?: number; cwd?: string; model?: string; disallowedTools?: string; tools?: string } = {}
): Promise<string> {
  const { timeoutMs = 30000, cwd = HOME, model = "claude-haiku-4-5-20251001", disallowedTools, tools } = opts;
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--model", model, "--no-session-persistence"];
    if (disallowedTools) args.push("--disallowedTools", disallowedTools);
    if (tools !== undefined) args.push("--tools", tools);
    const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("headless run timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `claude exited ${code}`));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ---------- terminal launching (macOS) ----------

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// AppleScript "tell application Terminal" requires TCC Automation permission for the calling
// process — fine when this server runs interactively, but silently denied (no error, no window)
// when running as a launchd background job with no way to prompt for that permission. Opening a
// .command file via `open` instead just uses Launch Services (same as double-clicking one in
// Finder), which doesn't need Automation access at all.
const GHOSTTY_APP = "/Applications/Ghostty.app";
function usingGhostty(): boolean {
  return existsSync(GHOSTTY_APP);
}

// Tag used both to force-title a Ghostty window at launch (via its `--title` config flag) and to
// search for that same window later (see focusExistingGhosttyWindow) — this is how a resume can
// find and refocus a session's already-open Ghostty window instead of spawning a duplicate,
// without any AppleScript/Automation permission (Ghostty's own window list is readable with a
// plain "tell application" query; only *manipulating other apps' UI* needs that permission).
// `--title` specifically forces the title and ignores any title-change escape sequences the
// running program (e.g. claude itself) sends — an OSC escape alone gets clobbered the moment
// claude sets its own title, so the tag wouldn't survive without this flag.
export function ghosttyWindowTag(sessionId: string): string {
  return `csm-${sessionId}`;
}

export async function openTerminalRunning(cwd: string, command: string, opts: { ghosttyTitle?: string } = {}) {
  // Ghostty: pass the command as real CLI args (`ghostty -e zsh -c "<command>"`) instead of
  // writing + executing a .command script file. Executing a script file makes Ghostty show its
  // own "Allow Ghostty to execute ...command" confirmation dialog every single launch; running a
  // command via -e is a normal CLI invocation and never triggers that prompt. `open -na <app>
  // --args ...` is required (rather than `open -a`) to actually forward args on macOS — `open -na`
  // still just uses Launch Services, so still no Automation/permission prompt either.
  if (usingGhostty()) {
    const titleArgs = opts.ghosttyTitle ? [`--title=${opts.ghosttyTitle}`] : [];
    spawn(
      "open",
      ["-na", GHOSTTY_APP, "--args", `--working-directory=${cwd}`, ...titleArgs, "-e", "zsh", "-c", command],
      { stdio: "ignore", detached: true }
    ).unref();
    return;
  }

  // Apple Terminal has no equivalent "-e" flag, so fall back to writing a .command file and
  // opening it via Launch Services (same as double-clicking one in Finder) — no permission
  // needed. (AppleScript "tell application Terminal" would need TCC Automation permission and is
  // silently denied when this server runs as a launchd background job with no way to prompt.)
  const script = `#!/bin/zsh\ncd ${shellQuote(cwd)}\n${command}\n`;
  const path = join(tmpdir(), `claude-sessions-launch-${crypto.randomUUID()}.command`);
  await Bun.write(path, script);
  await chmod(path, 0o755);
  spawn("open", ["-a", "Terminal", path], { stdio: "ignore", detached: true }).unref();
}

// ---------- reuse an already-open Terminal tab instead of spawning a new one ----------
// Requires Terminal Automation permission (System Settings → Privacy & Security → Automation)
// for whichever binary runs this server — unlike launching (which uses `open`, no permission
// needed), *finding* an existing tab means querying Terminal's window/tab list via AppleScript.

function getTtyForPid(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("ps", ["-o", "tty=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const tty = out.trim();
      resolve(tty && tty !== "??" ? tty : null);
    });
    child.on("error", () => resolve(null));
  });
}

function focusExistingTerminalTab(tty: string): Promise<boolean> {
  const script = `
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if (tty of t) contains "${tty}" then
            set frontmost of w to true
            set selected tab of w to t
            activate
            return true
          end if
        end repeat
      end repeat
      return false
    end tell
  `;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim() === "true"));
    child.on("error", () => resolve(false));
  });
}

// Ghostty has no custom AppleScript dictionary for tabs/ttys like Terminal.app, but it does expose
// its own window list via the standard Cocoa scripting suite (no Automation permission needed for
// a read-only "get name of every window" — that's the same class of query System Preferences
// itself uses to list open windows). Since every Ghostty window we launch is titled with
// ghosttyWindowTag(sessionId) via an OSC escape, finding "is a window named <tag> currently open"
// tells us this session already has a window, and `activate` (also permission-free — the same verb
// `open -na` already performs) brings Ghostty to the front so the user lands on it directly instead
// of getting a duplicate/broken second `claude --resume` process.
function focusExistingGhosttyWindow(tag: string): Promise<boolean> {
  const script = `
    tell application "Ghostty"
      if (name of every window) contains "${tag}" then
        activate
        return true
      end if
      return false
    end tell
  `;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim() === "true"));
    child.on("error", () => resolve(false));
  });
}

// If this session has a live process, try to bring its existing terminal window to front instead
// of spawning a duplicate. Returns true if an existing window was found and focused.
export async function tryFocusRunningSession(pid: number, ghosttyTag?: string): Promise<boolean> {
  if (!pidAlive(pid)) return false;
  if (usingGhostty()) {
    return ghosttyTag ? focusExistingGhosttyWindow(ghosttyTag) : false;
  }
  const tty = await getTtyForPid(pid);
  if (!tty) return false;
  return focusExistingTerminalTab(tty);
}

// ---------- prompt + command builders ----------

const REVIEW_PROMPT =
  "Review the uncommitted changes in this repo (git diff, plus any new untracked files) as a senior " +
  "engineer doing code review. Look specifically for: correctness bugs, edge cases that will break, " +
  "security vulnerabilities, and anything that looks unfinished or unsafe. List concrete findings with " +
  "file:line references. If everything looks solid, say so plainly instead of inventing nitpicks.";

function researchPrompt(task: string): string {
  return (
    "You are acting as a RESEARCH / THINKING agent, not an implementer. Do not write or edit any files. " +
    "Your job is to research and think through the following, then report back with a clear written " +
    "analysis and recommendation (options considered, tradeoffs, a concrete recommended plan): read " +
    "relevant existing code for context, search the web and read documentation/websites as needed, and " +
    "use any connected MCP tools that help gather accurate information. Do not implement anything — " +
    "just research, think, and report.\n\nTopic:\n" + task
  );
}

// Sonnet and Opus support an extended 1M-context variant via a "[1m]" suffix on the model alias
// — but ONLY on accounts entitled to it. Appending [1m] on a machine without that entitlement
// makes `claude --model sonnet[1m]` fail, so it's gated behind EXTENDED_CONTEXT (off by default,
// opt-in per machine via data/settings.json). Standard accounts just get the plain model alias.
export function modelAliasWithContext(model: string): string {
  if (EXTENDED_CONTEXT && (model === "sonnet" || model === "opus")) return `${model}[1m]`;
  return model;
}

export function buildLaunchScript(
  task: string,
  mode: string,
  opts: { model?: string | null; sessionId?: string | null; dangerous?: boolean } = {}
): string {
  const modelFlag = opts.model && KNOWN_MODELS.has(opts.model) ? ` --model ${modelAliasWithContext(opts.model)}` : "";
  const sessionFlag = opts.sessionId ? ` --session-id ${opts.sessionId}` : "";
  const dangerFlag = opts.dangerous !== false ? DANGEROUS_FLAG : "";

  if (mode === "research") {
    // still blocked from mutating files even in dangerous mode — --disallowedTools is enforced independently
    return `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${sessionFlag}${dangerFlag} --disallowedTools "Edit,Write,NotebookEdit" ${shellQuote(researchPrompt(task))}`;
  }

  const implementCmd = `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${sessionFlag}${dangerFlag} ${shellQuote(task)}`;
  if (mode === "implement-review") {
    // the reviewer pass continues the same session (--continue) so it has full context of what was just built
    const reviewCmd = `${shellQuote(CLAUDE_BIN)}${modelFlag}${EFFORT_FLAG}${dangerFlag} --continue ${shellQuote(REVIEW_PROMPT)}`;
    return `${implementCmd} && echo '--- implementation done, launching reviewer agent ---' && ${reviewCmd}`;
  }
  return implementCmd;
}

export function buildFileReviewPrompt(files: string[], focus?: string): string {
  const list = files.map((f) => `- ${f}`).join("\n");
  const focusLine = focus
    ? `\nFOCUS: the user only wants this reviewed: "${focus}". From the files below, review only the parts ` +
      "relevant to that — ignore unrelated changes. If none of the files relate to it, say so plainly.\n"
    : "";
  return (
    "Review the following files, changed in a previous session, as an experienced senior engineer doing a " +
    "rigorous code review. Read each file in full and reason about how it behaves under real load and real " +
    "input, not just whether it looks plausible. Specifically watch for:\n" +
    "- Correctness bugs and edge cases that will break (empty inputs, nulls, off-by-one, concurrency/race conditions).\n" +
    "- Performance traps: N+1 queries, work inside loops that should be batched, missing indexes, redundant network/API calls, re-renders.\n" +
    "- Security: injection, missing auth/authorization checks, secrets in code, unsafe input handling.\n" +
    "- Resilience: unhandled errors, missing timeouts/retries, silent failure paths.\n" +
    "- Maintainability: dead code, duplication, unclear names, anything left unfinished or unsafe.\n" +
    focusLine +
    "\nWrite your findings as a clean Markdown report, for someone non-technical to still follow:\n" +
    "- Start with a one-paragraph plain-English summary of the overall state of these changes.\n" +
    "- Then list each problem as a numbered item: '1. <short plain-English title>' followed by 1-3 sentences " +
    "explaining the problem in simple words (no jargon), why it matters, and the file:line it's in.\n" +
    "- Number findings sequentially starting at 1 with no gaps, so they can be referenced by number later.\n" +
    "- If a file has no problems, say so plainly instead of inventing nitpicks — do not pad the list.\n" +
    "- Do not fix anything, do not edit any files — this is a report only.\n\n" +
    "Files:\n" + list
  );
}

export function buildFixPrompt(review: ReviewRecord, selection: "all" | number[], writeTests: boolean): string {
  const scope =
    selection === "all"
      ? "Fix ALL numbered findings in the review below."
      : `Fix ONLY finding(s) numbered ${selection.join(", ")} in the review below — leave every other finding untouched.`;
  let prompt =
    `${scope} Make the exact code changes needed in the real files to resolve them.\n\n` +
    "--- REVIEW REPORT ---\n" + review.markdown + "\n--- END REVIEW REPORT ---";
  if (writeTests) {
    prompt +=
      "\n\nAfter fixing, write test cases covering the fix(es) (using this project's existing test setup/conventions), " +
      "then run them and confirm they pass. Fix any test failures you introduce.";
  }
  return prompt;
}

export function buildContextExtractionPrompt(digest: string): string {
  return (
    "Below is a condensed, chronological digest of a Claude Code session — USER messages, ASSISTANT replies, " +
    "and ASSISTANT tool-use actions (files edited, commands run). Some early history may be omitted for length; " +
    "focus on understanding the overall task and, especially, the most recent state.\n\n" +
    "--- TRANSCRIPT DIGEST ---\n" + digest + "\n--- END DIGEST ---\n\n" +
    "Summarize this session as a short, flat list of plain-English bullet points — nothing more. Just the key " +
    "points: what was being worked on, what actually got done, and where it's currently at / what's next. " +
    "8-12 bullets max, one sentence each, no sub-sections, no headers, no tables, no bold labels like " +
    "'Key decisions:' — just a plain markdown bullet list (`- point`), most important/recent things first. " +
    "Skip pleasantries and skip anything not needed to jog someone's memory about what happened."
  );
}

export function buildContinuationPrompt(ctx: ContextRecord): string {
  return (
    "You're continuing a previous session. Here is a condensed briefing of what happened and where it left off " +
    "— read it, then pick up exactly from \"Next steps\".\n\n--- CONTEXT BRIEFING ---\n" + ctx.markdown + "\n--- END BRIEFING ---"
  );
}

// ---------- detached background delegation ----------

// Turn one stream-json event into a short human-readable activity line, or null to skip it.
function activityLine(d: any): string | null {
  if (d?.type === "system" && d?.subtype === "init") return "▸ starting up…";
  if (d?.type === "assistant" && Array.isArray(d?.message?.content)) {
    for (const b of d.message.content) {
      if (b?.type === "tool_use") {
        const inp = b.input || {};
        const detail = inp.file_path || inp.command || inp.pattern || inp.url || inp.query || "";
        return `🔧 ${b.name}${detail ? `: ${String(detail).slice(0, 80)}` : ""}`;
      }
      if (b?.type === "text" && b.text?.trim()) {
        return `💭 ${b.text.trim().replace(/\s+/g, " ").slice(0, 100)}`;
      }
    }
  }
  return null;
}

// Fire-and-forget spawn with a LIVE activity feed. Uses stream-json so we can parse each tool-use /
// reasoning event as it happens; onProgress is called (throttled) with the rolling activity log, and
// onClose fires once with the final result. Returns immediately (do NOT await).
export function runClaudeHeadlessDetached(
  prompt: string,
  opts: { cwd: string; model?: string | null; permission: "read-only" | "edit"; timeoutMs?: number },
  callbacks: {
    onProgress: (activity: string[]) => void;
    onClose: (outcome: { ok: boolean; output: string; error: string | null }) => void;
  }
): number | null {
  const { cwd, model, permission, timeoutMs = 20 * 60 * 1000 } = opts;
  const modelArg = model && KNOWN_MODELS.has(model) ? modelAliasWithContext(model) : null;
  const args = ["-p", prompt, "--effort", "medium", "--no-session-persistence", "--output-format", "stream-json", "--verbose"];
  if (modelArg) args.push("--model", modelArg);
  if (permission === "read-only") args.push("--disallowedTools", "Edit,Write,NotebookEdit");
  else args.push("--dangerously-skip-permissions");

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    callbacks.onClose({ ok: false, output: "", error: e?.message ?? "failed to spawn claude" });
    return null;
  }

  const MAX_ACTIVITY = 60;
  const activity: string[] = [];
  const assistantText: string[] = [];
  let finalResult: string | null = null;
  let err = "";
  let buf = ""; // line buffer — a JSON object can span multiple stdout chunks
  let lastFlush = 0;

  const flush = (force = false) => {
    const now = Date.now();
    if (force || now - lastFlush > 1500) {
      lastFlush = now;
      callbacks.onProgress(activity.slice(-MAX_ACTIVITY));
    }
  };

  const timer = setTimeout(() => child.kill(), timeoutMs);

  child.stdout?.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d?.type === "result" && typeof d.result === "string") finalResult = d.result;
      if (d?.type === "assistant" && Array.isArray(d?.message?.content)) {
        for (const b of d.message.content) if (b?.type === "text" && b.text?.trim()) assistantText.push(b.text);
      }
      const line2 = activityLine(d);
      if (line2) {
        activity.push(line2);
        flush();
      }
    }
  });
  child.stderr?.on("data", (d) => (err += d.toString()));

  child.on("close", (code) => {
    clearTimeout(timer);
    flush(true);
    const output = (finalResult || assistantText.join("\n\n")).trim();
    if (code === 0) callbacks.onClose({ ok: true, output, error: null });
    else callbacks.onClose({ ok: false, output, error: err.trim() || `claude exited ${code}` });
  });
  child.on("error", (e) => {
    clearTimeout(timer);
    callbacks.onClose({ ok: false, output: "", error: e.message });
  });
  return child.pid ?? null;
}

// The master→slave briefing prompt: the agent's own instruction, plus a self-contained digest of
// what the master session did and which files it changed. The agent can read the whole repo; the
// file list just focuses it.
export function buildDelegationPrompt(agent: Agent, briefing: string, changedFiles: string[]): string {
  const files = changedFiles.length
    ? changedFiles.map((f) => `- ${f}`).join("\n")
    : "(no file changes were detected in that session)";
  return (
    agent.prompt +
    "\n\n--- CONTEXT FROM THE SESSION YOU ARE CONTINUING ---\n" +
    briefing +
    "\n\nFiles that session changed (read/inspect whatever else in the repo you need — you are NOT limited to these):\n" +
    files +
    "\n--- END CONTEXT ---"
  );
}
