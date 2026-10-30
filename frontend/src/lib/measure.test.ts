import assert from "node:assert/strict";
import { test } from "node:test";
import { nearestIndex, ordered, priceChange, span } from "./measure.ts";

const inr = (v: number) => `₹${v.toFixed(3)}`;

test("a rise reads as a signed change, its size and an up direction", () => {
  assert.deepEqual(priceChange(4, 4.5, inr), {
    direction: "up",
    change: "+₹0.500",
    percent: "12.50%",
  });
});

test("a fall carries a minus sign, and the percentage stays unsigned", () => {
  assert.deepEqual(priceChange(5, 4.6, inr), {
    direction: "down",
    change: "−₹0.400",
    percent: "8.00%",
  });
});

test("a change too small to show is flat rather than a rise of zero", () => {
  assert.deepEqual(priceChange(4, 4.0004, inr), {
    direction: "flat",
    change: "₹0.000",
    percent: "0.00%",
  });
});

test("there is no percentage when the start price is zero", () => {
  const change = priceChange(0, 1.25, inr);
  assert.equal(change.direction, "up");
  assert.equal(change.percent, null);
});

test("the nearest point wins, and points with no position are skipped", () => {
  assert.equal(nearestIndex([0, 10, 20, 30], 14), 1);
  assert.equal(nearestIndex([0, 10, 20, 30], 16), 2);
  assert.equal(nearestIndex([0, undefined, 20], 9), 0);
  assert.equal(nearestIndex([0, 10, 20], -50), 0);
  assert.equal(nearestIndex([0, 10, 20], 500), 2);
  assert.equal(nearestIndex([undefined, undefined], 5), -1);
});

test("a range reads left to right whichever way it was dragged", () => {
  assert.deepEqual(ordered({ anchor: 2, current: 7 }), [2, 7]);
  assert.deepEqual(ordered({ anchor: 7, current: 2 }), [2, 7]);
  assert.deepEqual(ordered({ anchor: 4, current: 4 }), [4, 4]);
});

test("a range of single-word ends joins tight, and of multi-word ends with a spaced dash", () => {
  assert.equal(span("09:15", "12:10"), "09:15-12:10");
  assert.equal(span("21 Oct", "28 Oct"), "21 Oct - 28 Oct");
  assert.equal(span("21 Oct 23:45", "22 Oct 00:00"), "21 Oct 23:45 - 22 Oct 00:00");
});
