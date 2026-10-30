import type { BlotterStatus } from "@/lib/api";

export const STATUS: Record<BlotterStatus, { label: string; dot: string; text: string }> = {
  pending: { label: "Pending", dot: "bg-gray-300", text: "text-gray-500" },
  cleared: { label: "Cleared", dot: "bg-[#00B398]", text: "text-teal-700" },
  partial: { label: "Partial", dot: "bg-amber-400", text: "text-amber-700" },
  not_cleared: { label: "Not cleared", dot: "bg-red-400", text: "text-red-600" },
};

export const STATUS_ORDER: BlotterStatus[] = ["pending", "cleared", "partial", "not_cleared"];

export const VERDICT: Record<string, { label: string; text: string }> = {
  APPROVED: { label: "Approved", text: "text-teal-700" },
  APPROVED_WITH_FLAGS: { label: "Flagged", text: "text-amber-700" },
  NEEDS_REVISION: { label: "Revise", text: "text-amber-700" },
  REJECTED: { label: "Rejected", text: "text-red-600" },
};

export const SEGMENT_STYLE: Record<string, string> = {
  DAM: "bg-blue-50 text-[#006DAE] border-blue-200",
  RTM: "bg-teal-50 text-teal-700 border-teal-200",
  TAM: "bg-violet-50 text-violet-700 border-violet-200",
};

export const ACTION_LABEL: Record<string, string> = {
  pre_trade_check: "Pre-trade check",
  submit: "Submitted",
};

const IST_SUBMITTED = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const DELIVERY = new Intl.DateTimeFormat("en-IN", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** A UTC timestamp from the API as an IST day and time, such as "29 Oct, 20:31". */
export const submittedAt = (utc: string | null) => (utc ? IST_SUBMITTED.format(new Date(utc)) : "-");

export const istClock = (at: Date) => IST_CLOCK.format(at);

/** A YYYY-MM-DD delivery date, such as "30 Oct 2026". */
export const deliveryDate = (date: string) => DELIVERY.format(new Date(`${date}T00:00:00Z`));

export const mwh = (value: number) =>
  value.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A price in INR/kWh. */
export const price = (value: number) => `₹${value.toFixed(2)}`;

export const percent = (value: number) => `${value.toFixed(value > 0 && value < 10 ? 1 : 0)}%`;
