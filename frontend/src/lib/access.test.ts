import assert from "node:assert/strict";
import { test } from "node:test";
import { HOME_PATH, actorId, isAllowed, localUser, safeCallbackPath } from "./access.ts";

test("actor ids are provider-qualified and lower-case", () => {
  assert.equal(actorId("github", " Desk-North "), "github:desk-north");
});

test("the allowlist admits listed ids, or everyone with *", () => {
  assert.equal(isAllowed("github:desk-north", "vercel:ops, GitHub:Desk-North"), true);
  assert.equal(isAllowed("github:someone", "vercel:ops,github:desk-north"), false);
  assert.equal(isAllowed("vercel:anyone", " * "), true);
});

test("an empty allowlist admits nobody", () => {
  assert.equal(isAllowed("github:desk-north", undefined), false);
  assert.equal(isAllowed("github:desk-north", " , "), false);
});

test("callbacks stay on this site", () => {
  assert.equal(safeCallbackPath("/blotter?session=abc#detail"), "/blotter?session=abc#detail");
  assert.equal(safeCallbackPath(["/risk", "/policy"]), "/risk");
  for (const unsafe of [
    undefined,
    null,
    "",
    "blotter",
    "//evil.example/x",
    "/\\evil.example",
    "https://evil.example/x",
    "javascript:alert(1)",
    "/login?callbackUrl=/risk",
  ]) {
    assert.equal(safeCallbackPath(unsafe), HOME_PATH, String(unsafe));
  }
});

test("local sign-in derives a handle from the display name", () => {
  assert.deepEqual(localUser("  Desk   North "), { handle: "desk-north", name: "Desk North" });
  assert.deepEqual(localUser("Ops / Night shift"), { handle: "ops-night-shift", name: "Ops / Night shift" });
  assert.equal(localUser("  !!!  "), null);
  assert.equal(localUser(undefined), null);
});

test("local sign-in bounds the name and handle", () => {
  const user = localUser(`${"a".repeat(39)} ${"b".repeat(40)}`);
  assert.ok(user);
  assert.equal(user.name.length, 60);
  assert.equal(user.handle, "a".repeat(39));
});
