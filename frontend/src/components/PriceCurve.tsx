"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * An illustrative Day-Ahead clearing price curve for the landing and sign-in pages: 96 blocks
 * with a forecast interval and bid volumes, and a cursor that walks the delivery day.
 * The data is generated, not fetched, so the public pages never call the API.
 */

const BLOCKS = 96;
const PEAK_BLOCK = 79;
const STEP_MS = 140;

const W = 960;
const PRICE_TOP = 16;
const PRICE_BOTTOM = 300;
const BAR_TOP = 326;
const BAR_BOTTOM = 392;
const H = 396;

const P_MIN = 1000;
const P_MAX = 11000;
const V_MAX = 50;

const bump = (h: number, centre: number, width: number) =>
  Math.exp(-((h - centre) ** 2) / (2 * width ** 2));

// A fixed pseudo-random wobble so the server and browser draw the same curve.
const wobble = (b: number) => {
  const x = Math.sin(b * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
};

interface Block {
  price: number;
  low: number;
  high: number;
  volume: number;
}

// Night base, a morning ramp, a midday solar trough and the evening peak.
const DAY: Block[] = (() => {
  const prices = Array.from({ length: BLOCKS }, (_, b) => {
    const h = b / 4;
    const p =
      3300 + 2400 * bump(h, 8.5, 1.6) - 1250 * bump(h, 13, 2) + 6100 * bump(h, 20, 1.8);
    return Math.min(10000, Math.max(1500, p + 420 * wobble(b)));
  });
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return prices.map((price, b) => {
    const spread = price * (0.1 + 0.07 * bump(b / 4, 20, 2.2));
    const cheapness = 1 - (price - lo) / (hi - lo);
    return {
      price,
      low: price - spread,
      high: price + spread,
      volume: Math.round((8 + 34 * cheapness) * 2) / 2,
    };
  });
})();

const x = (b: number) => (b + 0.5) * (W / BLOCKS);
const y = (p: number) => PRICE_BOTTOM - ((p - P_MIN) / (P_MAX - P_MIN)) * (PRICE_BOTTOM - PRICE_TOP);
const barHeight = (v: number) => (v / V_MAX) * (BAR_BOTTOM - BAR_TOP);

const line = DAY.map((d, b) => `${b ? "L" : "M"}${x(b).toFixed(1)},${y(d.price).toFixed(1)}`).join("");
const area = `${line}L${x(BLOCKS - 1)},${PRICE_BOTTOM}L${x(0)},${PRICE_BOTTOM}Z`;
const band =
  DAY.map((d, b) => `${b ? "L" : "M"}${x(b).toFixed(1)},${y(d.high).toFixed(1)}`).join("") +
  DAY.slice()
    .reverse()
    .map((d, i) => `L${x(BLOCKS - 1 - i).toFixed(1)},${y(d.low).toFixed(1)}`)
    .join("") +
  "Z";

const clock = (b: number) => {
  const minutes = b * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};
const rupees = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function subscribeToMotion(onChange: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export default function PriceCurve({ readout = true }: { readout?: boolean }) {
  const reducedMotion = useSyncExternalStore(
    subscribeToMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => true,
  );
  const [block, setBlock] = useState(PEAK_BLOCK);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setBlock((b) => (b + 1) % BLOCKS), STEP_MS);
    return () => clearInterval(timer);
  }, [reducedMotion]);

  const shown = reducedMotion ? PEAK_BLOCK : block;
  const current = DAY[shown];
  const slide = reducedMotion || shown === 0 ? "none" : `transform ${STEP_MS}ms linear`;

  return (
    <figure className="m-0">
      {readout && (
        <figcaption className="grid grid-cols-3 gap-4 mb-5 tabular-nums">
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">Block</p>
            <p className="mt-1 text-sm text-white">
              {String(shown + 1).padStart(2, "0")}
              <span className="text-white/40"> · </span>
              {clock(shown)}-{clock(shown + 1)}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">Forecast</p>
            <p className="mt-1 text-sm text-white">
              {rupees(current.price)}
              <span className="text-white/40"> /MWh</span>
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-white/40">Bid</p>
            <p className="mt-1 text-sm text-white">
              {current.volume.toFixed(1)}
              <span className="text-white/40"> MW</span>
            </p>
          </div>
        </figcaption>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto block"
        role="img"
        aria-label="Illustrative Day-Ahead clearing price forecast for 96 blocks, with a forecast interval and bid volumes"
      >
        <defs>
          <linearGradient id="price-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#3EA6E8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#3EA6E8" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={PRICE_TOP + f * (PRICE_BOTTOM - PRICE_TOP)}
            y2={PRICE_TOP + f * (PRICE_BOTTOM - PRICE_TOP)}
            stroke="white"
            strokeOpacity="0.06"
          />
        ))}
        <line x1="0" x2={W} y1={PRICE_BOTTOM} y2={PRICE_BOTTOM} stroke="white" strokeOpacity="0.12" />

        <path d={band} fill="#00B398" fillOpacity="0.13" />
        <path d={area} fill="url(#price-area)" />
        <path d={line} fill="none" stroke="#5DB8F0" strokeWidth="2" strokeLinejoin="round" />

        {DAY.map((d, b) => (
          <rect
            key={b}
            x={x(b) - 3}
            y={BAR_BOTTOM - barHeight(d.volume)}
            width="6"
            height={barHeight(d.volume)}
            rx="1"
            fill={b === shown ? "#00B398" : "white"}
            fillOpacity={b === shown ? 1 : 0.13}
          />
        ))}

        <g style={{ transform: `translateX(${x(shown)}px)`, transition: slide }}>
          <line
            x1="0"
            x2="0"
            y1={PRICE_TOP}
            y2={BAR_BOTTOM}
            stroke="white"
            strokeOpacity="0.28"
            strokeDasharray="3 4"
          />
        </g>
        <g
          style={{
            transform: `translate(${x(shown)}px, ${y(current.price)}px)`,
            transition: slide,
          }}
        >
          <circle r="5" fill="#07111D" stroke="#5DB8F0" strokeWidth="2.5" />
        </g>
      </svg>

      <div className="mt-2 flex justify-between text-[11px] tabular-nums text-white/35">
        {["00:00", "06:00", "12:00", "18:00", "24:00"].map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </figure>
  );
}
