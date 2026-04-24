import assert from "node:assert/strict";
import test from "node:test";
import { ensureCodexCliArgs } from "../utils/codex.js";

test("ensureCodexCliArgs injects --full-auto when omitted", () => {
  assert.deepEqual(ensureCodexCliArgs([]), ["--full-auto"]);
  assert.deepEqual(ensureCodexCliArgs(["--full-auto"]), ["--full-auto"]);
  assert.deepEqual(ensureCodexCliArgs(["--yolo"]), ["--full-auto"]);
});

test("ensureCodexCliArgs supports madmax autonomy", () => {
  assert.deepEqual(ensureCodexCliArgs([], "madmax"), [
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
  assert.deepEqual(ensureCodexCliArgs(["--madmax"]), [
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
});

test("ensureCodexCliArgs preserves explicit modern autonomy flags", () => {
  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  assert.deepEqual(ensureCodexCliArgs(args), args);
});
