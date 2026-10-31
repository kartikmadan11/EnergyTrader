/**
 * Drag-to-measure on price charts: press on a chart and drag to see how the price changed
 * between the two points, as most market charts allow.
 */

/** Data indices of the point the drag started on and the point under the pointer now. */
export type MeasureRange = { anchor: number; current: number };

export type Direction = "up" | "down" | "flat";

export type PriceChange = {
  direction: Direction;
  /** Signed change as shown, e.g. "+₹0.412" or "−₹0.412". */
  change: string;
  /** Size of the change relative to the start, e.g. "8.12%". Null when the start is zero. */
  percent: string | null;
};

const MINUS = "−";

/**
 * The change from `start` to `end`, formatted with `formatPrice`. It is flat when it rounds
 * to zero at the precision `formatPrice` shows, so the pill never reads "+₹0.000 ↑".
 */
export function priceChange(
  start: number,
  end: number,
  formatPrice: (value: number) => string,
): PriceChange {
  const delta = end - start;
  const size = formatPrice(Math.abs(delta));
  const direction: Direction = size === formatPrice(0) ? "flat" : delta > 0 ? "up" : "down";
  const sign = direction === "up" ? "+" : direction === "down" ? MINUS : "";
  const ratio = direction === "flat" ? 0 : Math.abs(delta / start);
  return {
    direction,
    change: `${sign}${size}`,
    percent: start === 0 ? null : `${(ratio * 100).toFixed(2)}%`,
  };
}

/** Index of the position nearest `x`, skipping points with no position. -1 when there are none. */
export function nearestIndex(positions: readonly (number | undefined)[], x: number): number {
  let nearest = -1;
  let distance = Infinity;
  positions.forEach((position, i) => {
    if (position === undefined) return;
    const d = Math.abs(position - x);
    if (d < distance) {
      nearest = i;
      distance = d;
    }
  });
  return nearest;
}

/** The range in chart order, whichever way the drag went. */
export function ordered(range: MeasureRange): [number, number] {
  return range.anchor <= range.current
    ? [range.anchor, range.current]
    : [range.current, range.anchor];
}

/**
 * Names a range by its two ends. Single-word ends, such as times, read "09:15-12:10";
 * ends with spaces in them, such as dates, read "21 Oct - 28 Oct".
 */
export function span(from: string, to: string): string {
  return /\s/.test(from + to) ? `${from} - ${to}` : `${from}-${to}`;
}
