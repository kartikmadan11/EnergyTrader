export function formatINR(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(2)}`;
}

/**
 * A random version 4 UUID in lower case. Unlike crypto.randomUUID, getRandomValues also
 * works on plain-http origins, such as a self-hosted install on a LAN address.
 */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function blockToTime(block: number): string {
  const totalMinutes = (block - 1) * 15;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}`;
}

// Indian power markets run on IST, so "today" is the IST calendar date
// regardless of where the browser is. Matches the backend's market_today().
const IST_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** IST calendar date `offsetDays` from today, as YYYY-MM-DD. */
export function marketDate(offsetDays: number): string {
  const today = IST_DATE.format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function getTodayDate(): string {
  return marketDate(0);
}

export function getTomorrowDate(): string {
  return marketDate(1);
}

export function getYesterdayDate(): string {
  return marketDate(-1);
}

/** Qualitative grade for a forecast MAPE, shared by every accuracy view. */
export function mapeGrade(mape: number): { label: string; color: string } {
  if (mape < 5) return { label: "Excellent", color: "text-teal-600" };
  if (mape < 10) return { label: "Good", color: "text-[#006DAE]" };
  if (mape < 20) return { label: "Fair", color: "text-amber-600" };
  return { label: "Weak", color: "text-red-600" };
}

export const SEGMENTS = ["DAM", "RTM", "TAM"] as const;
export const STRATEGIES = ["conservative", "balanced", "aggressive"] as const;
