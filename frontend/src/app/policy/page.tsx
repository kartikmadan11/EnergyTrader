"use client";

import { useEffect, useState, useCallback } from "react";
import {
  listPolicies,
  getActivePolicy,
  activatePolicy,
  comparePolicies,
  updatePolicy,
  errorMessage,
  POLICY_CHANGED_EVENT,
  type DSMPolicy,
  type PolicyComparison,
} from "@/lib/api";
import PageHeader from "@/components/PageHeader";

// ── Field metadata ──────────────────────────────────────────────────────────────

type FieldMeta = {
  key: keyof DSMPolicy;
  label: string;
  unit: "%" | "×" | "INR" | "MW" | "";
  hint: string;
  editable: boolean;
  min?: number;
  max?: number;
  step?: number;
};

const NUMERIC_FIELDS: FieldMeta[] = [
  { key: "deviation_band", label: "Permissible Deviation Band", unit: "%", hint: "Deviations within this band attract no penalty. Stored as a fraction (0.10 = 10%).", editable: true, min: 1, max: 30, step: 0.5 },
  { key: "penalty_rate", label: "Base Penalty Multiplier", unit: "×", hint: "Multiplier applied to energy charge for each MW of excess deviation.", editable: true, min: 1, max: 5, step: 0.1 },
  { key: "severe_deviation_threshold", label: "Severe Deviation Threshold", unit: "%", hint: "Deviations beyond this level trigger an additional surcharge on top of the base penalty.", editable: true, min: 5, max: 50, step: 0.5 },
  { key: "severe_penalty_multiplier", label: "Severe Deviation Surcharge", unit: "×", hint: "Additional multiplier stacked on the base penalty for severe deviations.", editable: true, min: 1, max: 5, step: 0.1 },
  { key: "price_ceiling", label: "DSM Price Ceiling", unit: "INR", hint: "Maximum permissible bid price per kWh (exchange cap).", editable: true, min: 1, max: 50, step: 0.5 },
  { key: "price_floor", label: "DSM Price Floor", unit: "INR", hint: "Minimum permissible bid price per kWh.", editable: true, min: 0, max: 5, step: 0.01 },
  { key: "technical_minimum_mw", label: "Technical Minimum", unit: "MW", hint: "Minimum bid volume for DAM/RTM market segments.", editable: true, min: 0.1, max: 10, step: 0.1 },
];

const STATUS_OPTIONS = ["active", "draft", "superseded"];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDisplay(v: number, unit: FieldMeta["unit"]): string {
  if (unit === "%") return `${(v * 100).toFixed(0)}%`;
  if (unit === "×") return `${v.toFixed(1)}×`;
  if (unit === "INR") return `₹${v.toFixed(2)}/kWh`;
  if (unit === "MW") return `${v} MW`;
  return String(v);
}

// Convert stored fraction → display input value for % fields
function toDisplay(v: number, unit: FieldMeta["unit"]): number {
  return unit === "%" ? parseFloat((v * 100).toFixed(4)) : v;
}

// Convert display input value → stored fraction for % fields
function toStore(v: number, unit: FieldMeta["unit"]): number {
  return unit === "%" ? v / 100 : v;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-700 border-green-200",
  draft: "bg-yellow-100 text-yellow-700 border-yellow-200",
  superseded: "bg-gray-100 text-gray-500 border-gray-200",
};

// ── Components ─────────────────────────────────────────────────────────────────

function PolicyCard({
  policy,
  isActive,
  onView,
  onEdit,
}: {
  policy: DSMPolicy;
  isActive: boolean;
  onView: (p: DSMPolicy) => void;
  onEdit: (p: DSMPolicy) => void;
}) {
  const badge = STATUS_BADGE[policy.status] ?? STATUS_BADGE.superseded;

  return (
    <div
      className={`bg-white rounded-xl border-2 p-5 transition-all ${
        isActive
          ? "border-[#006DAE] shadow-md shadow-[#006DAE]/10"
          : "border-gray-200 hover:border-gray-300"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-bold text-gray-900">{policy.name}</h2>
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border uppercase tracking-wide ${badge}`}
            >
              {policy.status}
            </span>
            {isActive && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#EEF5FB] text-[#006DAE] border border-[#006DAE]/30 uppercase tracking-wide">
                ACTIVE
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Effective: {policy.effective_date} &nbsp;·&nbsp; ID:{" "}
            <code className="font-mono text-gray-600">{policy.regulation_id}</code>
          </p>
        </div>

        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => onView(policy)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-[#006DAE] hover:text-[#006DAE] transition-colors"
          >
            View
          </button>
          <button
            onClick={() => onEdit(policy)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#006DAE] text-white hover:bg-[#005a8e] transition-colors"
          >
            Edit
          </button>
        </div>
      </div>

      {/* Key parameters grid */}
      <div className="grid grid-cols-2 gap-2">
        {NUMERIC_FIELDS.slice(0, 4).map((meta) => (
          <div
            key={String(meta.key)}
            className="bg-gray-50 rounded-lg px-3 py-2 group relative"
          >
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">
              {meta.label}
            </p>
            <p className="text-lg font-bold text-gray-900 mt-0.5">
              {fmtDisplay(policy[meta.key] as number, meta.unit)}
            </p>
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-10 hidden group-hover:block w-44 pointer-events-none">
              <div className="bg-gray-900 text-white text-[10px] rounded px-2 py-1 leading-relaxed text-center">
                {meta.hint}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── View Drawer ────────────────────────────────────────────────────────────────

function ViewDrawer({
  policy,
  onClose,
  onEdit,
}: {
  policy: DSMPolicy;
  onClose: () => void;
  onEdit: (p: DSMPolicy) => void;
}) {
  const badge = STATUS_BADGE[policy.status] ?? STATUS_BADGE.superseded;

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="w-full max-w-md bg-white shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-gray-900">{policy.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border uppercase tracking-wide ${badge}`}>
                {policy.status}
              </span>
              <span className="text-[11px] text-gray-400">
                ID: <code className="font-mono">{policy.regulation_id}</code>
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 flex-1">
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Description</p>
            <p className="text-xs text-gray-700 leading-relaxed">{policy.description}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Effective Date</p>
            <p className="text-xs text-gray-700">{policy.effective_date}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Parameters</p>
            <div className="space-y-1">
              {NUMERIC_FIELDS.map((f) => (
                <div key={String(f.key)} className="flex items-center justify-between py-1.5 border-b border-gray-50">
                  <p className="text-xs text-gray-600">{f.label}</p>
                  <span className="text-sm font-bold text-gray-900">
                    {fmtDisplay(policy[f.key] as number, f.unit)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-4">
          <button
            onClick={() => { onClose(); onEdit(policy); }}
            className="w-full text-sm font-semibold py-2.5 rounded-lg bg-[#006DAE] text-white hover:bg-[#005a8e] transition-colors"
          >
            Edit This Policy
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Modal ─────────────────────────────────────────────────────────────────

function EditModal({
  policy,
  onClose,
  onSaved,
}: {
  policy: DSMPolicy;
  onClose: () => void;
  onSaved: (updated: DSMPolicy) => void;
}) {
  const editableFields = NUMERIC_FIELDS.filter((f) => f.editable);
  const [form, setForm] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      editableFields.map((f) => [String(f.key), toDisplay(policy[f.key] as number, f.unit)])
    )
  );
  const [status, setStatus] = useState<string>(policy.status);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const updates: Partial<DSMPolicy> = { status: status as DSMPolicy["status"] };
      for (const f of editableFields) {
        (updates as Record<string, unknown>)[String(f.key)] = toStore(form[String(f.key)], f.unit);
      }
      const result = await updatePolicy(policy.regulation_id, updates);
      window.dispatchEvent(new Event(POLICY_CHANGED_EVENT));
      onSaved(result.policy);
    } catch (e: unknown) {
      setSaveError(errorMessage(e, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Edit Policy</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">{policy.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 py-4 space-y-4 flex-1">
          {/* Status */}
          <div>
            <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">
              Status
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-[#006DAE]"
            >
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Numeric fields */}
          {editableFields.map((f) => (
            <div key={String(f.key)}>
              <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">
                {f.label}{" "}
                {f.unit && (
                  <span className="text-gray-400 normal-case font-normal">
                    ({f.unit === "%" ? "percentage points" : f.unit})
                  </span>
                )}
              </label>
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={f.step}
                value={form[String(f.key)]}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, [String(f.key)]: parseFloat(e.target.value) }))
                }
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-[#006DAE]"
              />
            </div>
          ))}

          {saveError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
              {saveError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 text-sm font-semibold py-2 rounded-lg border border-gray-200 text-gray-600 hover:border-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 text-sm font-semibold py-2 rounded-lg bg-[#006DAE] text-white hover:bg-[#005a8e] disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Compare Panel ─────────────────────────────────────────────────────────────

function ComparePanel({
  comparison,
}: {
  comparison: PolicyComparison | null;
}) {
  if (!comparison) return null;

  const { diffs, policy_a, policy_b } = comparison;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="text-sm font-bold text-gray-900">Regulatory Impact Analysis</h3>

      <div className="overflow-x-auto mt-3">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-2 pr-3 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">
                Parameter
              </th>
              <th className="text-right py-2 px-3 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">
                {policy_a.name}
              </th>
              <th className="text-right py-2 px-3 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">
                {policy_b.name}
              </th>
              <th className="text-right py-2 pl-3 font-semibold text-gray-500 uppercase tracking-wide text-[10px]">
                Change
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {diffs.map((d) => {
              const meta = NUMERIC_FIELDS.find((m) => String(m.key) === d.field);

              return (
                <tr key={d.field} className="hover:bg-gray-50 transition-colors">
                  <td className="py-2 pr-3 font-medium text-gray-700">
                    {meta?.label ?? d.field}
                  </td>
                  <td className="text-right py-2 px-3 text-gray-500">
                    {meta ? fmtDisplay(d.policy_a_value, meta.unit) : d.policy_a_value}
                  </td>
                  <td className="text-right py-2 px-3 font-semibold text-gray-900">
                    {meta ? fmtDisplay(d.policy_b_value, meta.unit) : d.policy_b_value}
                  </td>
                  <td className="text-right py-2 pl-3">
                    {d.pct_change !== null && (
                      <span
                        title={d.direction === "stricter" ? "Stricter for participants" : "Looser for participants"}
                        className={`inline-flex items-center gap-1 font-bold text-[11px] ${
                          d.direction === "stricter" ? "text-red-600" : "text-green-600"
                        }`}
                      >
                        {d.pct_change > 0 ? "▲" : "▼"} {Math.abs(d.pct_change)}%
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
        {comparison.summary}
      </p>
    </div>
  );
}

export default function PolicyPage() {
  const [policies, setPolicies] = useState<DSMPolicy[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [comparison, setComparison] = useState<PolicyComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [drawerPolicy, setDrawerPolicy] = useState<DSMPolicy | null>(null);
  const [editPolicy, setEditPolicy] = useState<DSMPolicy | null>(null);

  const refreshComparison = useCallback(async (all: DSMPolicy[]) => {
    if (all.length >= 2) {
      try {
        const c = await comparePolicies(all[1].regulation_id, all[0].regulation_id);
        setComparison(c);
      } catch { /* non-fatal */ }
    }
  }, []);

  // Load policies on mount
  useEffect(() => {
    async function load() {
      try {
        const [all, active] = await Promise.all([listPolicies(), getActivePolicy()]);
        setPolicies(all);
        setActiveId(active.regulation_id);
        await refreshComparison(all);
      } catch (e: unknown) {
        setError(errorMessage(e, "Failed to load policies"));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [refreshComparison]);

  async function handleDropdownChange(regulationId: string) {
    if (regulationId === activeId) return;
    setSwitching(true);
    try {
      await activatePolicy(regulationId);
      window.dispatchEvent(new Event(POLICY_CHANGED_EVENT));
      setActiveId(regulationId);
      const name = policies.find((p) => p.regulation_id === regulationId)?.name ?? regulationId;
      setToast(`Policy switched to "${name}"`);
      setTimeout(() => setToast(null), 3500);
    } catch (e: unknown) {
      setError(errorMessage(e, "Failed to switch policy"));
    } finally {
      setSwitching(false);
    }
  }

  function handleSaved(updated: DSMPolicy) {
    const next = policies.map((p) => (p.regulation_id === updated.regulation_id ? updated : p));
    setPolicies(next);
    refreshComparison(next);
    setEditPolicy(null);
    setToast("Policy saved");
    setTimeout(() => setToast(null), 3000);
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-gray-400 animate-pulse">Loading policies…</div>
      </div>
    );
  }

  const active = policies.find((p) => p.regulation_id === activeId);

  return (
    <div className="flex flex-col gap-4">
      {toast && (
        <div className="fixed top-16 right-6 z-50 bg-green-600 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      <PageHeader
        title="DSM Regulation Policy"
        description="Deviation Settlement Mechanism rules applied to bid validation, pre-trade checks and risk"
        actions={
          <>
            <label htmlFor="active-policy" className="text-xs font-semibold text-gray-500">
              Active Policy
            </label>
            <div className="relative">
              <select
                id="active-policy"
                value={activeId}
                onChange={(e) => handleDropdownChange(e.target.value)}
                disabled={switching}
                className="h-9 text-sm font-medium border border-[var(--border)] rounded-lg pl-3 pr-8 bg-white focus:outline-none focus:border-[#006DAE] disabled:opacity-60 appearance-none cursor-pointer"
              >
                {policies.map((p) => (
                  <option key={p.regulation_id} value={p.regulation_id}>{p.name}</option>
                ))}
              </select>
              <svg
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            {switching && <span className="text-xs text-gray-400 animate-pulse">Switching…</span>}
            {active && (
              <button
                onClick={() => setEditPolicy(active)}
                className="btn-secondary h-9 !py-0 border-[#006DAE]"
              >
                Edit Active
              </button>
            )}
          </>
        }
      />

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* Active summary banner */}
        {active && (
          <div className="rounded-xl bg-[#EEF5FB] border border-[#006DAE]/20 px-5 py-4 flex items-center gap-4">
            <div className="w-8 h-8 rounded-lg bg-[#006DAE] flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-xs font-bold text-[#006DAE]">Active Regulation</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{active.name}</p>
              <p className="text-[11px] text-gray-500 mt-0.5">
                Deviation band: <strong>{fmtDisplay(active.deviation_band, "%")}</strong>{" "}
                &nbsp;·&nbsp; Penalty:{" "}
                <strong>{fmtDisplay(active.penalty_rate, "×")}</strong>{" "}
                &nbsp;·&nbsp; Severe surcharge above{" "}
                {fmtDisplay(active.severe_deviation_threshold, "%")}
              </p>
            </div>
          </div>
        )}

        {/* Policy cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {policies.map((p) => (
            <PolicyCard
              key={p.regulation_id}
              policy={p}
              isActive={p.regulation_id === activeId}
              onView={setDrawerPolicy}
              onEdit={setEditPolicy}
            />
          ))}
        </div>

        {/* Comparison panel */}
        <ComparePanel comparison={comparison} />

      {/* View Drawer */}
      {drawerPolicy && (
        <ViewDrawer
          policy={drawerPolicy}
          onClose={() => setDrawerPolicy(null)}
          onEdit={(p) => { setDrawerPolicy(null); setEditPolicy(p); }}
        />
      )}

      {/* Edit Modal */}
      {editPolicy && (
        <EditModal
          policy={editPolicy}
          onClose={() => setEditPolicy(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
