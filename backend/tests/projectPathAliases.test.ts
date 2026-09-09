// resolveAliasedCwd (sessions/index.ts) rescues a session whose recorded cwd no longer exists,
// via a registered project-path alias — a pure function, so this needs no PROJECTS_DIR/DATA_DIR
// fixture setup and can't collide with other test files' env vars.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAliasedCwd, hasSelfReferentialName } from "../src/sessions/index.ts";

let realProjectDir: string; // the project's actual, currently-existing folder
let staleProjectDir: string; // where a transcript claims the project lives — never created

beforeAll(async () => {
  realProjectDir = await mkdtemp(join(tmpdir(), "csm-alias-real-"));
  staleProjectDir = join(tmpdir(), "csm-alias-moved-away-" + crypto.randomUUID());
});

afterAll(async () => {
  await rm(realProjectDir, { recursive: true, force: true });
});

test("leaves a cwd alone when it still exists", () => {
  expect(resolveAliasedCwd(realProjectDir, {})).toBe(realProjectDir);
});

test("leaves a missing cwd alone when no alias is registered for it", () => {
  expect(resolveAliasedCwd(staleProjectDir, {})).toBe(staleProjectDir);
});

test("remaps a missing cwd through its registered alias", () => {
  const aliases = { [staleProjectDir]: realProjectDir };
  expect(resolveAliasedCwd(staleProjectDir, aliases)).toBe(realProjectDir);
});

test("ignores an alias for a path that still exists on its own", () => {
  const aliases = { [realProjectDir]: "/somewhere/else" };
  expect(resolveAliasedCwd(realProjectDir, aliases)).toBe(realProjectDir);
});

test("flags a leaf name reused by one of its own ancestors — confirmed live: this matched the wrong (outer) folder by basename alone", () => {
  expect(hasSelfReferentialName("/Users/me/Desktop/Repos/bsc/bsc-pos/BSC")).toBe(true);
});

test("does not flag an ordinary path with no repeated segment", () => {
  expect(hasSelfReferentialName("/Users/me/Desktop/Repos/jarvis")).toBe(false);
});
