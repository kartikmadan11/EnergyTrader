import assert from "node:assert/strict";
import { test } from "node:test";
import { SIDEBAR_COOKIE, isSidebarCollapsed, sidebarCookie } from "./sidebar.ts";

test("the sidebar is expanded unless the cookie says collapsed", () => {
  assert.equal(isSidebarCollapsed("collapsed"), true);
  assert.equal(isSidebarCollapsed("expanded"), false);
  assert.equal(isSidebarCollapsed(undefined), false);
  assert.equal(isSidebarCollapsed("garbage"), false);
});

test("the cookie the sidebar writes reads back as the same state", () => {
  for (const collapsed of [true, false]) {
    const [pair, ...attributes] = sidebarCookie(collapsed).split("; ");
    const [name, value] = pair.split("=");
    assert.equal(name, SIDEBAR_COOKIE);
    assert.equal(isSidebarCollapsed(value), collapsed);
    assert.ok(attributes.includes("path=/"), "applies to every page");
  }
});
