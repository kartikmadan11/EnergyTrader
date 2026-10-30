import assert from "node:assert/strict";
import { test } from "node:test";
import { newSessionId, shortDate } from "./utils.ts";

// The API's SESSION_ID_PATTERN for submitted bid sets.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("session ids are lower-case version 4 UUIDs the API accepts", () => {
  for (let i = 0; i < 200; i++) {
    const id = newSessionId();
    assert.match(id, CANONICAL_UUID);
    assert.equal(id[14], "4");
    assert.ok("89ab".includes(id[19]), id);
  }
});

test("session ids do not repeat", () => {
  const ids = new Set(Array.from({ length: 1000 }, newSessionId));
  assert.equal(ids.size, 1000);
});

test("a short date is the day without a leading zero and the month's name", () => {
  assert.equal(shortDate("2026-10-21"), "21 Oct");
  assert.equal(shortDate("2026-01-05"), "5 Jan");
  assert.equal(shortDate("2026-12-31"), "31 Dec");
});
