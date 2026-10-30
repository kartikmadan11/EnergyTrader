"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageHeader from "@/components/PageHeader";
import {
  blotterExportUrl,
  blotterQuery,
  errorMessage,
  getBlotter,
  type BlotterFilters,
  type BlotterOrder,
  type BlotterPage,
  type BlotterRow,
  type BlotterSort,
  type BlotterStatus,
} from "@/lib/api";
import { SEGMENTS, STRATEGIES, formatINR } from "@/lib/utils";
import SessionDrawer from "./SessionDrawer";
import {
  SEGMENT_STYLE,
  STATUS,
  STATUS_ORDER,
  VERDICT,
  deliveryDate,
  istClock,
  mwh,
  percent,
  price,
  submittedAt,
} from "./format";

const PAGE_SIZE = 50;
// The API returns at most this many rows per request; past it, filter or export.
const MAX_ROWS = 500;
const POLL_MS = 15_000;
const SEARCH_DEBOUNCE_MS = 250;
const SESSION_PREFIX = /^[0-9a-f-]{1,36}$/i;

interface Loaded {
  /** The request this page answers: filters, sort and row count. */
  key: string;
  page: BlotterPage;
  /** Sessions that arrived since the previous refresh of the same view. */
  arrived: Set<string>;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Blotter({ initialSession }: { initialSession: string | null }) {
  const [filters, setFilters] = useState<BlotterFilters>({});
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<BlotterOrder>({ sort: "submitted", order: "desc" });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [live, setLive] = useState(true);
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialSession);

  const prefix = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  const searchInvalid = prefix !== "" && !SESSION_PREFIX.test(prefix);
  const query = useMemo<BlotterFilters>(
    () => ({ ...filters, q: prefix && !searchInvalid ? prefix.toLowerCase() : undefined }),
    [filters, prefix, searchInvalid],
  );
  const key = `${blotterQuery(query, order)}&limit=${limit}`;

  useEffect(() => {
    let current = true;
    getBlotter(query, order, limit).then(
      (page) => {
        if (!current) return;
        setLoaded((previous) => {
          // Only a refresh of the same view can bring new arrivals; a new filter is not one.
          const known = previous?.key === key ? previous.page.rows : null;
          const arrived = new Set(
            known
              ? page.rows
                  .filter((r) => !known.some((k) => k.session_id === r.session_id))
                  .map((r) => r.session_id)
              : [],
          );
          return { key, page, arrived };
        });
        setFailure(null);
        setUpdatedAt(new Date());
      },
      (e) => {
        if (current) setFailure({ key, message: errorMessage(e, "Could not load the blotter.") });
      },
    );
    return () => {
      current = false;
    };
  }, [query, order, limit, key, tick]);

  // Refresh while the tab is visible, and as soon as it becomes visible again.
  useEffect(() => {
    if (!live) return;
    const refresh = () => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    };
    const timer = setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [live]);

  // Keep the open session in the address bar, so the view can be shared or reloaded.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (openId) url.searchParams.set("session", openId);
    else url.searchParams.delete("session");
    window.history.replaceState(null, "", url);
  }, [openId]);

  const page = loaded?.page ?? null;
  const rows = useMemo(() => page?.rows ?? [], [page]);
  const stale = loaded !== null && loaded.key !== key;
  const blockingFailure = failure !== null && (loaded === null || failure.key === key) ? failure : null;
  const filtered = Object.values(query).some(Boolean);
  const openIndex = rows.findIndex((r) => r.session_id === openId);

  const setFilter = <K extends keyof BlotterFilters>(name: K, value: BlotterFilters[K]) => {
    setFilters((f) => ({ ...f, [name]: value || undefined }));
    setLimit(PAGE_SIZE);
  };

  const clearFilters = () => {
    setFilters({});
    setSearch("");
    setLimit(PAGE_SIZE);
  };

  const sortBy = (sort: BlotterSort) => {
    setOrder((o) => ({ sort, order: o.sort === sort && o.order === "desc" ? "asc" : "desc" }));
    setLimit(PAGE_SIZE);
  };

  const step = useCallback(
    (delta: number) => {
      if (openIndex < 0) return;
      const next = rows[openIndex + delta];
      if (next) setOpenId(next.session_id);
    },
    [openIndex, rows],
  );
  const close = useCallback(() => {
    setOpenId(null);
    // Return focus to the row, so keyboard users carry on from the session they last viewed.
    if (openId) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`tr[data-session="${openId}"]`)?.focus(),
      );
    }
  }, [openId]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Trade Blotter"
        description="Every submitted bid session, with clearing results as prices are published"
        actions={
          <>
            <span className="text-[11px] text-gray-400 tabular-nums" aria-live="polite">
              {updatedAt ? `Updated ${istClock(updatedAt)} IST` : ""}
            </span>
            <button
              type="button"
              onClick={() => setLive((l) => !l)}
              aria-pressed={live}
              title={live ? "Refreshing every 15 seconds. Click to pause." : "Paused. Click to refresh automatically."}
              className="btn-secondary h-9 !py-0 flex items-center gap-2 !text-gray-700"
            >
              <span className="relative flex h-2 w-2">
                {live && (
                  <span className="absolute inline-flex h-full w-full rounded-full bg-[#00B398] opacity-60 motion-safe:animate-ping" />
                )}
                <span
                  className={`relative inline-flex h-2 w-2 rounded-full ${live ? "bg-[#00B398]" : "bg-gray-300"}`}
                />
              </span>
              {live ? "Live" : "Paused"}
            </button>
            <a
              href={blotterExportUrl(query, order)}
              download
              className="btn-secondary h-9 !py-0 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />
              </svg>
              Export CSV
            </a>
          </>
        }
      />

      <Totals page={page} />

      {/* Filters */}
      <div className="card py-3">
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="Segment" htmlFor="bl-segment">
            <select
              id="bl-segment"
              value={filters.segment ?? ""}
              onChange={(e) => setFilter("segment", e.target.value)}
              className="select-field h-9 !py-0"
            >
              <option value="">All</option>
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status" htmlFor="bl-status">
            <select
              id="bl-status"
              value={filters.status ?? ""}
              onChange={(e) => setFilter("status", e.target.value as BlotterStatus)}
              className="select-field h-9 !py-0"
            >
              <option value="">All</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS[s].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Strategy" htmlFor="bl-strategy">
            <select
              id="bl-strategy"
              value={filters.strategy ?? ""}
              onChange={(e) => setFilter("strategy", e.target.value)}
              className="select-field h-9 !py-0"
            >
              <option value="">All</option>
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Delivery from" htmlFor="bl-from">
            <input
              id="bl-from"
              type="date"
              value={filters.delivery_from ?? ""}
              max={filters.delivery_to}
              onChange={(e) => setFilter("delivery_from", e.target.value)}
              className="input-field h-9"
            />
          </Field>
          <Field label="Delivery to" htmlFor="bl-to">
            <input
              id="bl-to"
              type="date"
              value={filters.delivery_to ?? ""}
              min={filters.delivery_from}
              onChange={(e) => setFilter("delivery_to", e.target.value)}
              className="input-field h-9"
            />
          </Field>
          <Field label="Session" htmlFor="bl-search">
            <input
              id="bl-search"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(PAGE_SIZE);
              }}
              placeholder="Session id prefix"
              spellCheck={false}
              aria-invalid={searchInvalid}
              aria-describedby={searchInvalid ? "bl-search-hint" : undefined}
              className={`input-field h-9 w-44 font-mono text-xs ${searchInvalid ? "!border-amber-400" : ""}`}
            />
          </Field>
          {filters.trader && (
            <div>
              <span className="block text-xs text-gray-500 mb-1">Trader</span>
              <span className="h-9 flex items-center gap-1.5 rounded-lg border border-[#006DAE]/20 bg-[#EEF5FB] pl-3 pr-1.5 font-mono text-xs text-[#006DAE]">
                {filters.trader}
                <button
                  type="button"
                  onClick={() => setFilter("trader", undefined)}
                  aria-label="Remove the trader filter"
                  className="rounded p-0.5 hover:bg-white"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            </div>
          )}
          {filtered && (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-auto h-9 px-2 text-xs font-medium text-[#006DAE] hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
        {searchInvalid && (
          <p id="bl-search-hint" className="mt-2 text-[11px] text-amber-700">
            Session ids contain only 0-9, a-f and hyphens.
          </p>
        )}
      </div>

      {failure && !blockingFailure && (
        <div className="card py-2 bg-amber-50 border-amber-200 text-amber-800 text-xs" role="status">
          Refresh failed: {failure.message} Showing the last loaded results.
        </div>
      )}

      {blockingFailure ? (
        <div className="card flex items-center justify-between gap-4 bg-red-50 border-red-200" role="alert">
          <p className="text-xs text-red-700">{blockingFailure.message}</p>
          <button type="button" onClick={() => setTick((t) => t + 1)} className="btn-secondary h-8 !py-0 text-xs">
            Try again
          </button>
        </div>
      ) : page === null ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState filtered={filtered} onClear={clearFilters} />
      ) : (
        <div className={`card p-0 overflow-hidden transition-opacity ${stale ? "opacity-60" : ""}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] text-gray-500">
                  <SortHeader sort="submitted" order={order} onSort={sortBy}>
                    Submitted
                  </SortHeader>
                  <th className="px-3 py-2.5 font-medium">Session</th>
                  <SortHeader sort="delivery" order={order} onSort={sortBy}>
                    Delivery
                  </SortHeader>
                  <th className="px-3 py-2.5 font-medium">Market</th>
                  <SortHeader sort="volume" order={order} onSort={sortBy} align="right">
                    MWh
                  </SortHeader>
                  <th className="px-3 py-2.5 font-medium text-right">Avg ₹/kWh</th>
                  <SortHeader sort="value" order={order} onSort={sortBy} align="right">
                    Value
                  </SortHeader>
                  <SortHeader sort="fill" order={order} onSort={sortBy}>
                    Fill
                  </SortHeader>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Check</th>
                  <th className="px-3 py-2.5 font-medium">Trader</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Row
                    key={row.session_id}
                    row={row}
                    open={row.session_id === openId}
                    arrived={loaded?.arrived.has(row.session_id) ?? false}
                    onOpen={() => setOpenId(row.session_id)}
                    onTrader={(trader) => setFilter("trader", trader)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-gray-100 px-4 py-2.5 text-[11px] text-gray-500">
            <span className="tabular-nums">
              Showing {rows.length.toLocaleString("en-IN")} of{" "}
              {page.totals.sessions.toLocaleString("en-IN")} sessions
            </span>
            {page.next_cursor &&
              (limit < MAX_ROWS ? (
                <button
                  type="button"
                  onClick={() => setLimit((l) => Math.min(MAX_ROWS, l + PAGE_SIZE))}
                  disabled={stale}
                  className="font-medium text-[#006DAE] hover:underline disabled:opacity-50"
                >
                  Load {Math.min(PAGE_SIZE, page.totals.sessions - rows.length)} more
                </button>
              ) : (
                <span>Narrow the filters or export the CSV to see the rest.</span>
              ))}
          </div>
        </div>
      )}

      {openId && (
        <SessionDrawer
          sessionId={openId}
          row={openIndex >= 0 ? rows[openIndex] : null}
          position={openIndex >= 0 ? { index: openIndex, count: rows.length } : null}
          onStep={step}
          onClose={close}
        />
      )}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs text-gray-500 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

function Totals({ page }: { page: BlotterPage | null }) {
  const t = page?.totals;
  const clearedShare = t && t.priced_volume_mwh > 0 ? (t.cleared_mwh / t.priced_volume_mwh) * 100 : null;
  const clearedPrice = t && t.cleared_mwh > 0 ? t.cleared_cost_inr / (t.cleared_mwh * 1000) : null;
  const tiles = [
    { label: "Sessions", value: t ? t.sessions.toLocaleString("en-IN") : null, note: "matching the filters" },
    { label: "Bid volume", value: t ? `${mwh(t.volume_mwh)} MWh` : null, note: "across all blocks" },
    { label: "Bid value", value: t ? formatINR(t.value_inr) : null, note: "bid price × volume" },
    {
      label: "Cleared",
      value: t ? (clearedShare === null ? "-" : percent(clearedShare)) : null,
      note: t
        ? clearedShare === null
          ? "awaiting clearing prices"
          : `${mwh(t.cleared_mwh)} of ${mwh(t.priced_volume_mwh)} priced MWh`
        : "",
    },
    {
      label: "Avg cleared price",
      value: t ? (clearedPrice === null ? "-" : `${price(clearedPrice)}/kWh`) : null,
      note: t ? (clearedPrice === null ? "nothing cleared yet" : `${formatINR(t.cleared_cost_inr)} at MCP`) : "",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <div key={tile.label} className="card py-3">
          <p className="text-[11px] font-medium text-gray-500">{tile.label}</p>
          {tile.value === null ? (
            <div className="mt-1.5 h-6 w-20 rounded bg-gray-100 animate-pulse" />
          ) : (
            <p className="mt-1 text-lg font-semibold text-gray-900 tabular-nums">{tile.value}</p>
          )}
          <p className="mt-0.5 text-[11px] text-gray-400 truncate">{tile.note}</p>
        </div>
      ))}
    </div>
  );
}

function SortHeader({
  sort,
  order,
  onSort,
  align = "left",
  children,
}: {
  sort: BlotterSort;
  order: BlotterOrder;
  onSort: (sort: BlotterSort) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const active = order.sort === sort;
  return (
    <th
      className={`px-3 py-2.5 font-medium ${align === "right" ? "text-right" : ""}`}
      aria-sort={active ? (order.order === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(sort)}
        className={`inline-flex items-center gap-1 hover:text-gray-900 ${active ? "text-gray-900" : ""} ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {children}
        <svg
          className={`w-3 h-3 transition-transform ${active ? "opacity-100" : "opacity-0"} ${active && order.order === "asc" ? "rotate-180" : ""}`}
          viewBox="0 0 12 12"
          aria-hidden
        >
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </th>
  );
}

function Row({
  row,
  open,
  arrived,
  onOpen,
  onTrader,
}: {
  row: BlotterRow;
  open: boolean;
  arrived: boolean;
  onOpen: () => void;
  onTrader: (trader: string) => void;
}) {
  const ref = useRef<HTMLTableRowElement>(null);
  const status = STATUS[row.status];
  const verdict = row.verdict ? VERDICT[row.verdict] : undefined;

  // Keep the open session visible while stepping through the list from the drawer.
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  return (
    <tr
      ref={ref}
      data-session={row.session_id}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      aria-selected={open}
      className={`cursor-pointer border-b border-gray-100 last:border-0 outline-none focus-visible:bg-[#EEF5FB] ${
        open ? "bg-[#EEF5FB]" : "hover:bg-gray-50"
      } ${arrived ? "row-arrive" : ""}`}
    >
      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-gray-600">{submittedAt(row.submitted_at)}</td>
      <td className="px-3 py-2.5 font-mono text-[11px] text-gray-500" title={row.session_id}>
        {row.session_id.slice(0, 8)}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-gray-900">{deliveryDate(row.target_date)}</td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span
          className={`inline-block rounded border px-1.5 py-px text-[10px] font-semibold ${SEGMENT_STYLE[row.segment] ?? "border-gray-200 text-gray-600"}`}
        >
          {row.segment}
        </span>
        <span className="ml-2 text-gray-600">{label(row.strategy)}</span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-gray-900">{mwh(row.volume_mwh)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">{price(row.avg_price)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-gray-900">{formatINR(row.value_inr)}</td>
      <td className="px-3 py-2.5">
        {row.fill_pct === null ? (
          <span className="text-gray-300">-</span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-14 overflow-hidden rounded-full bg-gray-100">
              <span
                className="block h-full rounded-full bg-[#00B398]"
                style={{ width: `${Math.min(100, row.fill_pct)}%` }}
              />
            </span>
            <span className="w-9 tabular-nums text-gray-600">{percent(row.fill_pct)}</span>
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span className={`inline-flex items-center gap-1.5 ${status.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        {verdict ? (
          <span className={verdict.text}>
            {verdict.label}
            {row.score !== null && <span className="text-gray-400 tabular-nums"> · {row.score.toFixed(0)}</span>}
          </span>
        ) : (
          <span className="text-gray-300">-</span>
        )}
      </td>
      <td className="px-3 py-2.5 max-w-[150px]">
        {row.submitted_by ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTrader(row.submitted_by!);
            }}
            title={`Show only sessions submitted by ${row.submitted_by}`}
            className="block max-w-full truncate font-mono text-[11px] text-gray-500 hover:text-[#006DAE] hover:underline"
          >
            {row.submitted_by}
          </button>
        ) : (
          <span className="text-gray-300">-</span>
        )}
      </td>
    </tr>
  );
}

function TableSkeleton() {
  return (
    <div className="card p-0 overflow-hidden" aria-busy="true" aria-label="Loading sessions">
      <div className="h-9 border-b border-gray-200 bg-gray-50" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-6 border-b border-gray-100 px-3 py-3 last:border-0">
          <div className="h-3 w-24 rounded bg-gray-100 animate-pulse" />
          <div className="h-3 w-16 rounded bg-gray-100 animate-pulse" />
          <div className="h-3 w-20 rounded bg-gray-100 animate-pulse" />
          <div className="h-3 flex-1 rounded bg-gray-100 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <div className="card flex flex-col items-center py-14 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-gray-100 text-gray-400">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
          />
        </svg>
      </div>
      {filtered ? (
        <>
          <p className="text-sm font-medium text-gray-700">No sessions match these filters</p>
          <button type="button" onClick={onClear} className="mt-2 text-xs font-medium text-[#006DAE] hover:underline">
            Clear filters
          </button>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-gray-700">No bid sessions yet</p>
          <p className="mt-1 text-xs text-gray-500">
            Sessions appear here as soon as a bid set is submitted from the{" "}
            <Link href="/workstation" className="text-[#006DAE] hover:underline">
              Workstation
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
