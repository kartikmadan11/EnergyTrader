import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOME_PATH,
  SESSION_MAX_AGE_S,
  actorId,
  isAllowed,
  localUser,
  safeCallbackPath,
  sessionIsCurrent,
} from "./access.ts";

test("actor ids are provider-qualified and lower-case", () => {
  assert.equal(actorId("github", " Desk-North "), "github:desk-north");
});

test("the allowlist admits listed ids, or everyone with *", () => {
  assert.equal(isAllowed("github:desk-north", "vercel:ops, GitHub:Desk-North"), true);
  assert.equal(isAllowed("github:someone", "vercel:ops,github:desk-north"), false);
  assert.equal(isAllowed("vercel:anyone", " * "), true);
});

test("provider:* admits every account from that provider only", () => {
  const allowlist = "Vercel:*, github:desk-north";
  assert.equal(isAllowed("vercel:anyone", allowlist), true);
  assert.equal(isAllowed("github:desk-north", allowlist), true);
  assert.equal(isAllowed("github:someone", allowlist), false);
  assert.equal(isAllowed("vercelx:anyone", allowlist), false);
  assert.equal(isAllowed("anyone", "vercel:*"), false);
});

test("a session ends a trading day after sign-in, however active", () => {
  const nowS = 1_800_000_000;
  const prod = { nowS, development: false };
  const signedIn = (agoS: number) => ({ actorId: "vercel:desk-north", signedInAt: nowS - agoS });
  assert.equal(sessionIsCurrent(signedIn(0), "vercel:*", prod), true);
  assert.equal(sessionIsCurrent(signedIn(SESSION_MAX_AGE_S - 1), "vercel:*", prod), true);
  assert.equal(sessionIsCurrent(signedIn(SESSION_MAX_AGE_S), "vercel:*", prod), false);
  // A sign-in time from the future means a forged or corrupted claim.
  assert.equal(sessionIsCurrent(signedIn(-3600), "vercel:*", prod), false);
});

test("a session ends once its account leaves the allowlist", () => {
  const nowS = 1_800_000_000;
  const prod = { nowS, development: false };
  const claims = { actorId: "github:desk-north", signedInAt: nowS - 60 };
  assert.equal(sessionIsCurrent(claims, "github:desk-north", prod), true);
  assert.equal(sessionIsCurrent(claims, "github:desk-south", prod), false);
  assert.equal(sessionIsCurrent(claims, undefined, prod), false);
});

test("sessions from before sign-in times were recorded are not current", () => {
  const prod = { nowS: 1_800_000_000, development: false };
  assert.equal(sessionIsCurrent({ actorId: "github:desk-north" }, "*", prod), false);
  assert.equal(sessionIsCurrent({ signedInAt: 1_800_000_000 }, "*", prod), false);
});

test("local sessions only count in development", () => {
  const nowS = 1_800_000_000;
  const claims = { actorId: "local:desk-north", signedInAt: nowS - 60 };
  assert.equal(sessionIsCurrent(claims, undefined, { nowS, development: true }), true);
  assert.equal(sessionIsCurrent(claims, "*", { nowS, development: false }), false);
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
