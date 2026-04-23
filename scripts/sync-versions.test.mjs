import assert from "node:assert/strict";
import test from "node:test";
import { isValidVersion, resolveNextVersion } from "./sync-versions.mjs";

test("accepts stable and managed prerelease versions only", () => {
  assert.equal(isValidVersion("1.2.3"), true);
  assert.equal(isValidVersion("1.2.3-alpha.0"), true);
  assert.equal(isValidVersion("1.2.3-beta.4"), true);
  assert.equal(isValidVersion("1.2.3-rc.2"), true);
  assert.equal(isValidVersion("1.2.3-preview.1"), false);
  assert.equal(isValidVersion("1.2.3+build.1"), false);
});

test("bumps stable versions", () => {
  assert.equal(resolveNextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(resolveNextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(resolveNextVersion("0.1.0", "major"), "1.0.0");
});

test("starts prerelease channels from the next patch", () => {
  assert.equal(resolveNextVersion("0.1.0", "alpha"), "0.1.1-alpha.0");
  assert.equal(resolveNextVersion("0.1.0", "beta"), "0.1.1-beta.0");
  assert.equal(resolveNextVersion("0.1.0", "rc"), "0.1.1-rc.0");
});

test("increments and promotes prerelease channels in order", () => {
  assert.equal(resolveNextVersion("0.1.1-alpha.0", "alpha"), "0.1.1-alpha.1");
  assert.equal(resolveNextVersion("0.1.1-alpha.1", "beta"), "0.1.1-beta.0");
  assert.equal(resolveNextVersion("0.1.1-beta.2", "rc"), "0.1.1-rc.0");
  assert.equal(resolveNextVersion("0.1.1-rc.1", "release"), "0.1.1");
});

test("rejects backward prerelease moves", () => {
  assert.throws(
    () => resolveNextVersion("0.1.1-beta.0", "alpha"),
    /cannot move prerelease backward/
  );
});

test("accepts explicit managed versions", () => {
  assert.equal(resolveNextVersion("0.1.0", "0.2.0-beta.0"), "0.2.0-beta.0");
});
