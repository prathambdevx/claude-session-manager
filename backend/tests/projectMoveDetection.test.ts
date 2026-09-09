// findCandidatesUnder takes an explicit root, so these build a throwaway fixture tree — never
// touch the real HOME (see findCandidatesForBasename, which is the HOME-scoped wrapper around it).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCandidatesUnder } from "../src/sessions/projectMoveDetection.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "csm-move-detect-"));
  await mkdir(join(root, "Workspace", "my-project"), { recursive: true });
  await mkdir(join(root, "Workspace", "my-project", "node_modules", "my-project"), { recursive: true });
  await mkdir(join(root, "Workspace", "OtherApp"), { recursive: true });
  await mkdir(join(root, "Archive", "duplicate-name"), { recursive: true });
  await mkdir(join(root, "Backups", "duplicate-name"), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("finds a uniquely-named directory nested a few levels down", async () => {
  const found = await findCandidatesUnder(root, "otherapp".toLowerCase());
  expect(found).toEqual([join(root, "Workspace", "OtherApp")]);
});

test("matches case-insensitively", async () => {
  const found = await findCandidatesUnder(root, "MY-PROJECT".toLowerCase());
  expect(found).toContain(join(root, "Workspace", "my-project"));
});

test("never descends into node_modules, even when it contains a same-named directory", async () => {
  const found = await findCandidatesUnder(root, "my-project");
  expect(found).toEqual([join(root, "Workspace", "my-project")]);
});

test("stops early and reports every match once a name is ambiguous", async () => {
  const found = await findCandidatesUnder(root, "duplicate-name");
  expect(found.length).toBeGreaterThan(1);
});

test("returns nothing for a name that doesn't exist anywhere", async () => {
  const found = await findCandidatesUnder(root, "does-not-exist-anywhere");
  expect(found).toEqual([]);
});
