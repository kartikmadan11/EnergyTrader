import assert from "node:assert/strict";
import { test } from "node:test";
import { backendToken } from "./backend-token.ts";

// The API verifies these tokens in Python (backend/common/auth.py); its test pins the same
// vector, so a change to either side's encoding fails one of the two suites.
const CONTRACT_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJnaXRodWI6ZGVzay1ub3J0aCIsIm5hbWUiOiJEZXNrIE5vcnRoIiwiaXNzIjoiZW5lcmd5dHJhZGVy" +
  "LXdlYiIsImF1ZCI6ImVuZXJneXRyYWRlci1hcGkiLCJpYXQiOjE3NjcyMjU2MDAsImV4cCI6MTc2NzIyNTY2MH0." +
  "VpzUbMnF3eCJuzlcqlHZDy8lWa9Swd_pzWPd5jsBHbY";

const desk = { id: "github:desk-north", name: "Desk North" };

test("tokens match the API's encoding", () => {
  assert.equal(backendToken(desk, "contract-test-secret", 1_767_225_600_000), CONTRACT_TOKEN);
});

test("tokens expire a minute after they are issued", () => {
  const payload = backendToken(desk, "secret", 1_767_225_600_000).split(".")[1];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.exp - claims.iat, 60);
});

test("a token needs a secret", () => {
  assert.throws(() => backendToken(desk, ""), /needs a secret/);
});
