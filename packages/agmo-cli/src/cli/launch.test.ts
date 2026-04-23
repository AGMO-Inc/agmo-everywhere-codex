import assert from "node:assert/strict";
import test from "node:test";
import { ensureCodexCliArgs } from "../utils/codex.js";

test("ensureCodexCliArgs injects --yolo when omitted", () => {
  assert.deepEqual(ensureCodexCliArgs([]), ["--yolo"]);
  assert.deepEqual(ensureCodexCliArgs(["--full-auto"]), ["--yolo", "--full-auto"]);
});

test("ensureCodexCliArgs preserves an explicit --yolo flag", () => {
  const args = ["--yolo", "--full-auto"];
  assert.deepEqual(ensureCodexCliArgs(args), args);
});
