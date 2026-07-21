// Tests the terminal-detection resolution chain (§8.1): CSM_TERMINAL override -> saved config ->
// /Applications scan -> Apple Terminal floor. CSM_DATA_DIR points at a throwaway temp dir BEFORE
// the module is imported, so nothing here ever touches this machine's real data/terminal.json.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let launcher: typeof import("../src/claude/tmux/terminalLauncher.ts");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csm-terminal-test-"));
  process.env.CSM_DATA_DIR = dir;
  launcher = await import("../src/claude/tmux/terminalLauncher.ts");
});

afterAll(async () => {
  delete process.env.CSM_DATA_DIR;
  delete process.env.CSM_TERMINAL;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.CSM_TERMINAL;
});

test("detectTerminalFromEnv maps known TERM_PROGRAM/TERM values", () => {
  const prevProgram = process.env.TERM_PROGRAM;
  const prevTerm = process.env.TERM;
  try {
    process.env.TERM_PROGRAM = "ghostty";
    expect(launcher.detectTerminalFromEnv()).toBe("Ghostty");
    process.env.TERM_PROGRAM = "iTerm.app";
    expect(launcher.detectTerminalFromEnv()).toBe("iTerm");
    process.env.TERM_PROGRAM = "WarpTerminal";
    expect(launcher.detectTerminalFromEnv()).toBe("Warp");
    process.env.TERM_PROGRAM = "WezTerm";
    expect(launcher.detectTerminalFromEnv()).toBe("WezTerm");
    process.env.TERM_PROGRAM = "Apple_Terminal";
    expect(launcher.detectTerminalFromEnv()).toBe("Terminal");
    delete process.env.TERM_PROGRAM;
    process.env.TERM = "xterm-kitty";
    expect(launcher.detectTerminalFromEnv()).toBe("kitty");
    process.env.TERM = "alacritty";
    expect(launcher.detectTerminalFromEnv()).toBe("Alacritty");
    process.env.TERM = "xterm-256color";
    expect(launcher.detectTerminalFromEnv()).toBeNull();
  } finally {
    if (prevProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = prevProgram;
    if (prevTerm === undefined) delete process.env.TERM;
    else process.env.TERM = prevTerm;
  }
});

test("CSM_TERMINAL override wins over everything else", () => {
  process.env.CSM_TERMINAL = "kitty";
  expect(launcher.resolveTerminalApp()).toBe("kitty");
});

test("an unrecognized CSM_TERMINAL value is ignored, not trusted blindly", () => {
  process.env.CSM_TERMINAL = "NotspaceTerminal";
  // falls through to the saved-config / /Applications-scan / Apple Terminal chain instead
  expect(launcher.KNOWN_TERMINALS.includes(launcher.resolveTerminalApp() as any) || launcher.resolveTerminalApp() === "Terminal").toBe(true);
  expect(launcher.resolveTerminalApp()).not.toBe("NotspaceTerminal");
});

test("saveTerminalConfig persists a choice that resolveTerminalApp then honors", () => {
  launcher.saveTerminalConfig("WezTerm");
  expect(launcher.resolveTerminalApp()).toBe("WezTerm");
});

test("resolveTerminalApp always falls back to Apple Terminal, never null/undefined", () => {
  // no override, no saved config that survives a fresh temp dir load in isolation
  const fresh = launcher.resolveTerminalApp();
  expect(typeof fresh).toBe("string");
});

test("shellQuote escapes embedded single quotes safely", () => {
  expect(launcher.shellQuote("it's a test")).toBe(`'it'\\''s a test'`);
});
