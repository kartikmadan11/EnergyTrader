"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DefaultZIndexes,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
  ZIndexLayer,
} from "recharts";
import {
  nearestIndex,
  ordered,
  priceChange,
  span,
  type Direction,
  type MeasureRange,
} from "@/lib/measure";

/** Charts with a measure leave this much margin above the plot, where the pill sits. */
export const MEASURE_MARGIN_TOP = 24;

const PILL_HEIGHT = 20;
const PILL_PAD_X = 8;

const TONE: Record<Direction, { text: string; fill: string; stroke: string; shade: string }> = {
  up: { text: "#0F766E", fill: "#F0FDFA", stroke: "#99F6E4", shade: "#00B398" },
  down: { text: "#B91C1C", fill: "#FEF2F2", stroke: "#FECACA", shade: "#EF4444" },
  flat: { text: "#4B5563", fill: "#F9FAFB", stroke: "#E5E7EB", shade: "#9CA3AF" },
};

const ARROW: Record<Direction, string> = { up: " ↑", down: " ↓", flat: "" };

type Point = { x: number; y: number; value: number };

/**
 * Press on the chart and drag to measure the change in one series between two points.
 * Render it as the last child of a Recharts chart whose top margin is MEASURE_MARGIN_TOP.
 * The measure stands in for the chart's tooltip, and clears on release or Escape.
 */
export default function RangeMeasure<T>({
  data,
  xKey,
  yKey,
  yAxisId,
  color,
  formatX,
  formatPrice,
}: {
  data: readonly T[];
  /** The XAxis dataKey. */
  xKey: keyof T;
  /** The series to measure. */
  yKey: keyof T;
  yAxisId?: string | number;
  /** The measured series' colour, for the dots on it. */
  color: string;
  /** How the pill names a point, such as its time of day. */
  formatX: (row: T) => string;
  /** Formats a price, and the size of a change, as the chart's tooltip does. */
  formatPrice: (value: number) => string;
}) {
  const [range, setRange] = useState<MeasureRange | null>(null);
  const hitArea = useRef<SVGRectElement>(null);
  const plot = usePlotArea();
  const xScale = useXAxisScale();
  const yScale = useYAxisScale(yAxisId);

  // Where each point with a value sits, so a drag snaps to the nearest one.
  const points = useMemo(
    () =>
      data.map((row): Point | undefined => {
        const raw = row[yKey];
        const value = raw == null ? NaN : Number(raw);
        if (!Number.isFinite(value)) return undefined;
        const x = xScale?.(row[xKey], { position: "middle" });
        const y = yScale?.(value);
        return x === undefined || y === undefined ? undefined : { x, y, value };
      }),
    [data, xKey, yKey, xScale, yScale],
  );

  const measuring = range !== null;
  useEffect(() => {
    if (!measuring) return;
    // Marks the chart so the stylesheet hides its hover tooltip, cursor and dot.
    const chart = hitArea.current?.closest(".recharts-wrapper");
    chart?.setAttribute("data-measuring", "");
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape cancels only the measure, not the dialog a chart may sit in.
      e.preventDefault();
      setRange(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      chart?.removeAttribute("data-measuring");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [measuring]);

  if (!plot) return null;

  const indexAt = (e: React.PointerEvent<SVGRectElement>) => {
    const toChart = e.currentTarget.getScreenCTM()?.inverse();
    if (!toChart) return -1;
    const { x } = new DOMPoint(e.clientX, e.clientY).matrixTransform(toChart);
    return nearestIndex(
      points.map((p) => p?.x),
      x,
    );
  };
  const end = () => setRange(null);

  const [from, to] = range ? ordered(range) : [-1, -1];
  const start = points[from];
  const finish = points[to];
  const shown = start && finish ? { start, finish } : null;
  const change = shown ? priceChange(shown.start.value, shown.finish.value, formatPrice) : null;
  const tone = TONE[change && from !== to ? change.direction : "flat"];
  const top = plot.y;
  const bottom = plot.y + plot.height;

  return (
    <>
      {shown && (
        <>
          <ZIndexLayer zIndex={DefaultZIndexes.area - 1}>
            <rect
              x={shown.start.x}
              y={top}
              width={shown.finish.x - shown.start.x}
              height={plot.height}
              fill={tone.shade}
              fillOpacity={0.08}
            />
          </ZIndexLayer>
          <ZIndexLayer zIndex={DefaultZIndexes.activeDot}>
            <g pointerEvents="none">
              {[shown.start, shown.finish].map((p, i) => (
                <line
                  key={`line-${i}`}
                  x1={p.x}
                  x2={p.x}
                  y1={top}
                  y2={bottom}
                  stroke="#94A3B8"
                  strokeDasharray="4 3"
                />
              ))}
              {[shown.start, shown.finish].map((p, i) => (
                <circle
                  key={`dot-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={4.5}
                  fill={color}
                  stroke="white"
                  strokeWidth={2}
                />
              ))}
            </g>
          </ZIndexLayer>
          <ZIndexLayer zIndex={DefaultZIndexes.label}>
            <Pill
              center={(shown.start.x + shown.finish.x) / 2}
              top={top - MEASURE_MARGIN_TOP}
              left={plot.x}
              right={plot.x + plot.width}
              tone={tone}
              headline={
                from === to || !change
                  ? formatPrice(shown.start.value)
                  : `${change.change}${change.percent ? ` (${change.percent})` : ""}${ARROW[change.direction]}`
              }
              span={from === to ? formatX(data[from]) : span(formatX(data[from]), formatX(data[to]))}
            />
          </ZIndexLayer>
        </>
      )}
      {/* Above every other layer, so a press anywhere in the plot starts a measure. */}
      <ZIndexLayer zIndex={DefaultZIndexes.label + 1}>
        <rect
          ref={hitArea}
          x={plot.x}
          y={plot.y}
          width={plot.width}
          height={plot.height}
          fill="transparent"
          style={{ cursor: "crosshair", touchAction: "pan-y" }}
          // A drag would otherwise select the text it passes over.
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (!e.isPrimary || e.button !== 0) return;
            const i = indexAt(e);
            if (i < 0) return;
            // The drag keeps following the pointer when it leaves the chart.
            e.currentTarget.setPointerCapture(e.pointerId);
            setRange({ anchor: i, current: i });
          }}
          onPointerMove={(e) => {
            if (!range) return;
            const i = indexAt(e);
            if (i >= 0 && i !== range.current) setRange({ ...range, current: i });
          }}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
        />
      </ZIndexLayer>
    </>
  );
}

function Pill({
  center,
  top,
  left,
  right,
  tone,
  headline,
  span,
}: {
  center: number;
  top: number;
  left: number;
  right: number;
  tone: (typeof TONE)[Direction];
  headline: string;
  span: string;
}) {
  const group = useRef<SVGGElement>(null);
  const box = useRef<SVGRectElement>(null);
  const label = useRef<SVGTextElement>(null);

  // SVG text cannot size its own background, so the pill measures its text before paint,
  // then centres itself over the range without leaving the plot.
  useLayoutEffect(() => {
    if (!group.current || !box.current || !label.current) return;
    const width = Math.ceil(label.current.getBBox().width) + PILL_PAD_X * 2;
    const x = Math.max(left, Math.min(center - width / 2, right - width));
    // The box is inset half a pixel so its 1px stroke lands on whole pixels.
    box.current.setAttribute("width", String(width - 1));
    group.current.setAttribute("transform", `translate(${Math.round(x)} ${top})`);
  });

  return (
    <g ref={group} pointerEvents="none">
      <rect
        ref={box}
        x={0.5}
        y={0.5}
        height={PILL_HEIGHT - 1}
        rx={(PILL_HEIGHT - 1) / 2}
        fill={tone.fill}
        stroke={tone.stroke}
      />
      <text
        ref={label}
        x={PILL_PAD_X}
        y={PILL_HEIGHT / 2}
        dominantBaseline="central"
        fontSize={11}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        <tspan fill={tone.text} fontWeight={600}>
          {headline}
        </tspan>
        <tspan dx={6} fill="#6B7280">
          {span}
        </tspan>
      </text>
    </g>
  );
}
