"use client";

import { useState, type CSSProperties } from "react";
import type { ExcludedPosition } from "../hooks/useLpPnl";
import type { ManualEntry } from "../hooks/useManualEntries";

// Palette mirrors the analytics page so the section blends with the
// excluded-positions warning that sits directly above it.
const C = {
  bg:        "#000000",
  bg1:       "#060606",
  border:    "#1c1c1c",
  borderHi:  "#262626",
  text:      "#a8a8a8",
  textMid:   "#b4b4b4",
  textBright:"#e8e8e8",
  green:     "#00ff41",
  greenDim:  "#00b82a",
  greenFaint:"rgba(0,255,65,0.06)",
  red:       "#ff4757",
  redFaint:  "rgba(255,71,87,0.06)",
  amber:     "#ffaa00",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

export interface NeedsInputPosition {
  excluded: ExcludedPosition;
  feesUsd: number;
  /** True when on-chain data is now authoritative; the saved entry is shown
   *  for visibility/edit but does NOT contribute to LP P&L totals. */
  onChainAvailable: boolean;
}

export interface ManualEntriesSectionProps {
  positions: NeedsInputPosition[];
  entriesByPositionId: Record<string, ManualEntry>;
  onSave: (
    positionId: string,
    depositUsd: number,
    withdrawalUsd: number,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

function fmt$(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  })}`;
}
function fmt$Signed(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  })}`;
}

const inputBaseStyle: CSSProperties = {
  background: "#000",
  border: `1px solid ${C.borderHi}`,
  color: C.textBright,
  fontFamily: FONT,
  fontSize: 13,
  padding: "8px 10px",
  width: "100%",
  outline: "none",
  letterSpacing: "0.02em",
  borderRadius: 2,
  // No spinner arrows on number inputs — see globals .me-input rule.
};

interface RowState {
  dep: string;
  wd: string;
  saving: boolean;
  error: string | null;
  justSaved: boolean;
  // True when user has clicked EDIT on a previously-saved entry — flips the
  // card back into the input variant pre-filled with the saved amounts.
  editing: boolean;
}

function ManualEntryCard({
  np,
  saved,
  state,
  setState,
  onSave,
}: {
  np: NeedsInputPosition;
  saved: ManualEntry | undefined;
  state: RowState;
  setState: (next: RowState) => void;
  onSave: ManualEntriesSectionProps["onSave"];
}) {
  // Treat zero-zero saved entries as "not really saved" so the user gets the
  // input view again. Real saves require at least one non-zero amount.
  const hasRealSave = !!saved && (saved.depositUsd > 0 || saved.withdrawalUsd > 0);
  const showInputs = !hasRealSave || state.editing;

  const handleSave = async () => {
    const dep = Number(state.dep);
    const wd = Number(state.wd);
    if (!Number.isFinite(dep) || dep < 0) {
      setState({ ...state, error: "Deposit must be a non-negative number" });
      return;
    }
    if (!Number.isFinite(wd) || wd < 0) {
      setState({ ...state, error: "Withdrawal must be a non-negative number" });
      return;
    }
    setState({ ...state, saving: true, error: null });
    const result = await onSave(np.excluded.id, dep, wd);
    if (result.ok) {
      setState({ ...state, saving: false, error: null, editing: false, justSaved: true });
    } else {
      setState({ ...state, saving: false, error: result.reason ?? "Save failed" });
    }
  };

  const netPnl = hasRealSave && saved
    ? saved.withdrawalUsd + np.feesUsd - saved.depositUsd
    : 0;
  const netPnlPct = hasRealSave && saved && saved.depositUsd > 0
    ? (netPnl / saved.depositUsd) * 100
    : 0;
  const netPositive = netPnl >= 0;

  return (
    <div
      style={{
        border: `1px solid ${C.borderHi}`,
        background: C.bg1,
        padding: "16px 18px",
        marginBottom: 12,
      }}
    >
      {/* Header row — pair, protocol, chain, CLOSED badge */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 14, color: C.textBright, fontWeight: 700 }}>
          {np.excluded.pair}
        </div>
        <span style={{
          fontSize: 10, padding: "2px 7px",
          border: `1px solid ${C.borderHi}`, background: "#0a0a0a",
          color: C.textMid, letterSpacing: "0.08em",
        }}>
          {np.excluded.protocol}
        </span>
        <span style={{
          fontSize: 10, padding: "2px 7px",
          border: `1px solid ${C.borderHi}`, background: "#0a0a0a",
          color: C.textMid, letterSpacing: "0.08em",
        }}>
          {np.excluded.chain}
        </span>
        <span style={{
          fontSize: 10, padding: "2px 7px",
          border: `1px solid ${C.amber}55`, background: `${C.amber}11`,
          color: C.amber, letterSpacing: "0.12em",
        }}>
          CLOSED
        </span>
        {np.onChainAvailable && (
          <span
            title="On-chain data is now available and authoritative for this position. Your saved entry is shown here for visibility but is NOT contributing to the LP P&L totals."
            style={{
              fontSize: 10, padding: "2px 7px",
              border: `1px solid ${C.green}55`, background: `${C.green}11`,
              color: C.green, letterSpacing: "0.12em",
            }}
          >
            ON-CHAIN
          </span>
        )}
      </div>

      {np.onChainAvailable && (
        <div style={{
          fontSize: 11, color: C.text, marginBottom: 12,
          opacity: 0.75, lineHeight: 1.5,
        }}>
          On-chain data is authoritative for this position — your saved entry
          is shown for reference and isn&apos;t contributing to the LP P&amp;L
          totals above. Set both to 0 to remove.
        </div>
      )}

      {/* Fees line — green checkmark + amount when fees were retrieved,
          amber note when they weren't (rate-limit / empty activity scan).
          Either way the user can enter deposit + withdrawal; Net P&L just
          uses 0 fees in the latter case. */}
      {np.feesUsd > 0 ? (
        <div style={{
          fontSize: 12, color: C.green, letterSpacing: "0.04em",
          marginBottom: 12,
        }}>
          ✓ Fees earned: <span style={{ fontWeight: 700 }}>+{fmt$(np.feesUsd)}</span>
          <span style={{ color: C.text, opacity: 0.6, marginLeft: 8, fontSize: 11 }}>
            (auto-retrieved on-chain)
          </span>
        </div>
      ) : (
        <div style={{
          fontSize: 12, color: C.amber, letterSpacing: "0.04em",
          marginBottom: 12,
          opacity: 0.9,
        }}>
          ⚠ Fees not retrieved
          <span style={{ color: C.text, opacity: 0.6, marginLeft: 8, fontSize: 11 }}>
            (refreshing may recover them — Net P&amp;L will use 0 fees until then)
          </span>
        </div>
      )}

      {showInputs ? (
        <>
          <div
            className="me-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr auto",
              gap: 10,
              alignItems: "end",
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Deposit USD
              </span>
              <input
                className="me-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                style={inputBaseStyle}
                value={state.dep}
                onChange={(e) => setState({ ...state, dep: e.target.value })}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.green; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.borderHi; }}
                disabled={state.saving}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Withdrawal USD
              </span>
              <input
                className="me-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                style={inputBaseStyle}
                value={state.wd}
                onChange={(e) => setState({ ...state, wd: e.target.value })}
                onFocus={(e) => { e.currentTarget.style.borderColor = C.green; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = C.borderHi; }}
                disabled={state.saving}
              />
            </label>
            <button
              type="button"
              className="me-save-btn"
              onClick={handleSave}
              disabled={state.saving}
              style={{
                background: "transparent",
                border: `1px solid ${C.green}`,
                color: C.green,
                fontFamily: FONT,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                padding: "9px 16px",
                cursor: state.saving ? "wait" : "pointer",
                opacity: state.saving ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {state.saving ? "Saving…" : "Save"}
            </button>
          </div>

          {state.error && (
            <div style={{ marginTop: 8, fontSize: 11, color: C.red, letterSpacing: "0.04em" }}>
              {state.error}
            </div>
          )}

          {hasRealSave && (
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                onClick={() => setState({ ...state, editing: false })}
                style={{
                  background: "transparent",
                  border: "none",
                  color: C.text,
                  fontFamily: FONT,
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                  opacity: 0.7,
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </>
      ) : (
        // Saved state — display amounts + computed Net P&L + EDIT button
        <div
          className="me-saved"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr auto",
            gap: 16,
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 10, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
              Deposit
            </div>
            <div style={{ fontSize: 14, color: C.textBright, fontVariantNumeric: "tabular-nums" }}>
              {fmt$(saved?.depositUsd ?? 0)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
              Withdrawal
            </div>
            <div style={{ fontSize: 14, color: C.textBright, fontVariantNumeric: "tabular-nums" }}>
              {fmt$(saved?.withdrawalUsd ?? 0)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>
              Net P&amp;L
            </div>
            <div style={{
              fontSize: 14, fontWeight: 700,
              color: netPositive ? C.green : C.red,
              fontVariantNumeric: "tabular-nums",
            }}>
              {fmt$Signed(netPnl)}
              <span style={{ fontSize: 11, opacity: 0.7, fontWeight: 500, marginLeft: 6 }}>
                ({netPositive ? "+" : ""}{netPnlPct.toFixed(2)}%)
              </span>
            </div>
          </div>
          <button
            type="button"
            className="me-edit-btn"
            onClick={() => setState({
              ...state,
              editing: true,
              dep: String(saved?.depositUsd ?? 0),
              wd: String(saved?.withdrawalUsd ?? 0),
              justSaved: false,
              error: null,
            })}
            style={{
              background: "transparent",
              border: `1px solid ${C.borderHi}`,
              color: C.text,
              fontFamily: FONT,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              padding: "8px 14px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Edit
          </button>
        </div>
      )}

      {state.justSaved && !state.editing && hasRealSave && (
        <div style={{
          marginTop: 10,
          fontSize: 11,
          color: C.green,
          letterSpacing: "0.04em",
        }}>
          ✓ Saved — included in lifetime Net P&amp;L
        </div>
      )}
    </div>
  );
}

export default function ManualEntriesSection({
  positions,
  entriesByPositionId,
  onSave,
}: ManualEntriesSectionProps) {
  // Per-card local state — keyed by position id, lazily initialised.
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const getState = (id: string): RowState =>
    rowState[id] ?? { dep: "", wd: "", saving: false, error: null, justSaved: false, editing: false };
  const updateState = (id: string, next: RowState) =>
    setRowState((prev) => ({ ...prev, [id]: next }));

  if (positions.length === 0) return null;

  return (
    <div
      style={{
        margin: "0 26px 18px",
        border: `1px solid ${C.borderHi}`,
        background: C.bg1,
        padding: "16px 18px",
        fontFamily: FONT,
      }}
    >
      <style>{`
        /* Remove the up/down arrows from number inputs so the input visually
           matches the rest of the terminal aesthetic. */
        .me-input::-webkit-outer-spin-button,
        .me-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .me-input { -moz-appearance: textfield; }
        .me-save-btn:hover  { background: rgba(0,255,65,0.08); }
        .me-edit-btn:hover  { border-color: ${C.text}; color: ${C.textBright}; }
        @media (max-width: 768px) {
          .me-grid  { grid-template-columns: 1fr !important; }
          .me-saved { grid-template-columns: 1fr 1fr !important; row-gap: 12px !important; }
        }
      `}</style>

      <div style={{
        fontSize: 12, color: C.green, letterSpacing: "0.18em",
        textTransform: "uppercase", marginBottom: 6,
      }}>
        {"// "}<span style={{ color: C.greenDim }}>POSITIONS REQUIRING YOUR INPUT</span>
      </div>
      <div style={{
        fontSize: 12, color: C.text, lineHeight: 1.6, marginBottom: 14,
        opacity: 0.85,
      }}>
        Deposit and withdrawal history for these positions is not available on
        public blockchain RPCs. Your fees are always retrieved automatically.
        Enter your amounts once to calculate complete P&amp;L. Data is saved
        permanently to your account.
      </div>

      {positions.map((np) => (
        <ManualEntryCard
          key={np.excluded.id}
          np={np}
          saved={entriesByPositionId[np.excluded.id]}
          state={getState(np.excluded.id)}
          setState={(next) => updateState(np.excluded.id, next)}
          onSave={onSave}
        />
      ))}
    </div>
  );
}
