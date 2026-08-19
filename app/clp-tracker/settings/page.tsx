"use client";

import { type ChangeEvent, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  getClaims,
  getPositions,
  getSettings,
  getTransfers,
  savePositions,
  saveSettings,
} from "../lib/storage";
import { exportCSV, parseCSV } from "../lib/csv";
import {
  calcTotalFees,
  getEffectiveClaimed,
  getEffectiveDeposited,
} from "../lib/calculations";
import { useHydrated } from "../lib/useHydrated";
import type { AppSettings, FeeClaim, Position, Transfer } from "../lib/types";

const STORAGE_KEYS = [
  "clp_positions",
  "clp_claims",
  "clp_transfers",
  "clp_ranges",
  "clp_pool_pnl",
  "clp_business_pnl",
  "clp_withdrawals",
  "clp_position_prices",
  "clp_outlier_dismissals",
  "clp_stale_position_dismissals",
] as const;

const APP_VERSION = "v1.0.0";

type ImportState =
  | { kind: "idle" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

type CsvImportState = ImportState;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function numOrZero(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: string | undefined): number | null {
  if (!value || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateToIso(value: string | undefined): string | null {
  if (!value || value.trim() === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function splitPair(combined: string): { pair: string; feeTier: string } {
  const m = combined.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) return { pair: m[1], feeTier: m[2] };
  return { pair: combined, feeTier: "" };
}

function positionToCsvRow(
  p: Position,
  allClaims: FeeClaim[],
): Record<string, string | number | null> {
  const { pair, feeTier } = splitPair(p.pair);
  const deposited = getEffectiveDeposited(p);
  const claimed = getEffectiveClaimed(p, allClaims);
  return {
    Pair: pair,
    "Fee Tier": feeTier,
    Chain: p.chain,
    Protocol: p.protocol,
    "Entry Date": p.entryDatetime,
    "Deposited (USD)": deposited,
    "Current Balance": p.currentBalance,
    "New Fees": p.newFees,
    Claimed: claimed,
    "Total Fees": calcTotalFees(claimed, p.newFees),
    "Entry Price": p.entryPrice,
    "Range Down": p.bottomRange,
    "Range Up": p.topRange,
    "Base Token": p.token1Symbol,
    "Quote Token": p.token2Symbol,
    "Base Token Count": p.token1Count,
    "Quote Token Count": p.token2Count,
    "Short Open Date": p.shortDateStart ?? "",
    "Short Close Date": p.shortDateEnd ?? "",
    "Short Token Amount": p.shortTokenAmount,
    "Short USD Amount": p.shortUsdAmount,
    "Short Gain": p.shortGain,
    "Short Loss": p.shortLoss,
    "Short Funding Fees": p.shortFundingFees,
    "Short Total P&L": p.shortTotal,
    "Short Notes": p.shortNotes ?? "",
    "Out of Range Upside": p.outOfRangeUpside,
    "Out of Range Downside": p.outOfRangeDownside,
    Scalp: p.scalp ?? "",
    Status: p.status,
    "Exit Date": p.exitDatetime ?? "",
    Notes: p.notes,
  };
}

function claimToCsvRow(c: FeeClaim): Record<string, string | number | null> {
  return {
    Date: c.date,
    Pair: c.pair,
    Platform: c.platform,
    Chain: c.chain,
    "Token 1 Symbol": c.token1Symbol,
    "Token 1 Amount": c.token1Amount,
    "Token 2 Symbol": c.token2Symbol,
    "Token 2 Amount": c.token2Amount,
    "Converted to Stablecoin": c.convertedToStable ? "Yes" : "No",
    "Stable Symbol": c.stableSymbol ?? "",
    "Stable Amount": c.stableAmount,
    "Transaction ID": c.txId ?? "",
    "Current Position Value": c.currentPositionValue,
    Notes: c.notes,
  };
}

function transferToCsvRow(
  t: Transfer,
  positionPair: string,
): Record<string, string | number> {
  return {
    Date: t.date,
    "Position Pair": positionPair,
    Token: t.token,
    Amount: t.amount,
    Platform: t.platform,
    Destination: t.destination,
    "Transfer Type": t.transferType,
    // Blank means never classified, which behaves as redeployed.
    "Money Status": t.moneyStatus ?? "",
    Notes: t.notes,
  };
}

function csvRowToPosition(
  row: Record<string, string>,
): { ok: true; position: Position } | { ok: false; error: string } {
  const pair = (row["Pair"] ?? "").trim();
  const chain = (row["Chain"] ?? "").trim();
  const entryDate = (row["Entry Date"] ?? "").trim();
  const depositedRaw = (row["Deposited (USD)"] ?? "").trim();

  if (!pair) return { ok: false, error: "Missing required field: Pair" };
  if (!chain) return { ok: false, error: "Missing required field: Chain" };
  if (!entryDate) return { ok: false, error: "Missing required field: Entry Date" };
  if (depositedRaw === "")
    return { ok: false, error: "Missing required field: Deposited (USD)" };

  const deposited = Number(depositedRaw);
  if (!Number.isFinite(deposited)) {
    return { ok: false, error: "Invalid Deposited value" };
  }
  const entryIso = dateToIso(entryDate);
  if (entryIso === null) {
    return { ok: false, error: `Invalid Entry Date: ${entryDate}` };
  }

  const feeTier = (row["Fee Tier"] ?? "").trim();
  const combinedPair = feeTier
    ? `${pair} (${feeTier.endsWith("%") ? feeTier : `${feeTier}%`})`
    : pair;
  const status =
    (row["Status"] ?? "").trim().toLowerCase() === "closed" ? "closed" : "active";
  const claimed = numOrZero(row["Claimed"]);
  const newFees = numOrZero(row["New Fees"]);

  const position: Position = {
    id: newId(),
    pair: combinedPair,
    chain: chain.toUpperCase(),
    protocol: (row["Protocol"] ?? "").trim().toUpperCase(),
    entryDatetime: entryIso,
    exitDatetime: dateToIso(row["Exit Date"]),
    deposited,
    currentBalance: numOrZero(row["Current Balance"]) || deposited,
    newFees,
    claimed,
    totalFees: numOrZero(row["Total Fees"]) || claimed + newFees,
    bottomRange: numOrZero(row["Range Down"]),
    topRange: numOrZero(row["Range Up"]),
    token1Symbol: (row["Base Token"] ?? "").trim().toUpperCase(),
    token2Symbol: (row["Quote Token"] ?? "").trim().toUpperCase(),
    token1Count: numOrZero(row["Base Token Count"]),
    token2Count: numOrZero(row["Quote Token Count"]),
    entryPrice: numOrZero(row["Entry Price"]),
    shortDateStart: dateToIso(row["Short Open Date"]),
    shortDateEnd: dateToIso(row["Short Close Date"]),
    shortTokenAmount: numOrNull(row["Short Token Amount"]),
    shortUsdAmount: numOrNull(row["Short USD Amount"]),
    shortGain: numOrNull(row["Short Gain"]),
    shortLoss: numOrNull(row["Short Loss"]),
    shortFundingFees: numOrNull(row["Short Funding Fees"]),
    shortTotal: numOrNull(row["Short Total P&L"]),
    shortNotes: (row["Short Notes"] ?? "").trim() || null,
    outOfRangeUpside: numOrNull(row["Out of Range Upside"]),
    outOfRangeDownside: numOrNull(row["Out of Range Downside"]),
    scalp: numOrNull(row["Scalp"]),
    txLink: null,
    notes: row["Notes"] ?? "",
    status,
  };
  return { ok: true, position };
}

function todayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readKey(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" });
  const [csvImportState, setCsvImportState] = useState<CsvImportState>({
    kind: "idle",
  });
  const [pendingClear, setPendingClear] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvFileInputRef = useRef<HTMLInputElement>(null);

  const hydrated = useHydrated(() => {
    setSettings(getSettings());
  });

  const updateTransfersEnabled = (next: boolean) => {
    const updated: AppSettings = { ...settings, transfersEnabled: next };
    setSettings(updated);
    saveSettings(updated);
  };

  const handleExport = () => {
    if (typeof window === "undefined") return;
    const payload: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      version: APP_VERSION,
    };
    for (const key of STORAGE_KEYS) {
      payload[key] = readKey(key) ?? [];
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clp-tracker-backup-${todayDate()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Backup file is not a valid JSON object.");
      }
      const obj = parsed as Record<string, unknown>;
      const matchedKeys = STORAGE_KEYS.filter((k) => k in obj);
      if (matchedKeys.length === 0) {
        throw new Error(
          "Backup file does not contain any expected CLP Tracker keys.",
        );
      }
      for (const key of matchedKeys) {
        const value = obj[key];
        window.localStorage.setItem(key, JSON.stringify(value ?? []));
      }
      setImportState({
        kind: "success",
        message: `Imported ${matchedKeys.length} of ${STORAGE_KEYS.length} datasets. Reload other pages to see changes.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to read file.";
      setImportState({ kind: "error", message: msg });
    }
  };

  const handleExportPositionsCsv = () => {
    const allClaims = getClaims();
    const rows = getPositions().map((p) => positionToCsvRow(p, allClaims));
    exportCSV(`clp-positions-${todayDate()}.csv`, rows);
  };

  const handleExportClaimsCsv = () => {
    const rows = getClaims().map(claimToCsvRow);
    exportCSV(`clp-claims-${todayDate()}.csv`, rows);
  };

  const handleExportTransfersCsv = () => {
    const positionPair = new Map<string, string>();
    for (const p of getPositions()) positionPair.set(p.id, p.pair);
    const rows = getTransfers().map((t) =>
      transferToCsvRow(t, positionPair.get(t.positionId) ?? ""),
    );
    exportCSV(`clp-transfers-${todayDate()}.csv`, rows);
  };

  const handleCsvImportClick = () => {
    csvFileInputRef.current?.click();
  };

  const handleCsvFileChosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (rows.length === 0) {
        throw new Error("CSV is empty or could not be parsed.");
      }
      const imported: Position[] = [];
      for (let i = 0; i < rows.length; i++) {
        const result = csvRowToPosition(rows[i]);
        if (!result.ok) {
          throw new Error(`Row ${i + 2}: ${result.error}`);
        }
        imported.push(result.position);
      }
      savePositions([...getPositions(), ...imported]);
      setCsvImportState({
        kind: "success",
        message: `${imported.length} ${imported.length === 1 ? "position" : "positions"} imported successfully.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to read file.";
      setCsvImportState({ kind: "error", message: msg });
    }
  };

  const handleClearAll = () => {
    if (typeof window === "undefined") return;
    for (const key of STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
    window.location.reload();
  };

  return (
    <section className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Manage features, your data, and app information.
        </p>
      </header>

      <Card title="Features">
        <SettingRow
          label="Fee Transfers Tracking"
          description="Track where you send your claimed fees after claiming — e.g. to lending protocols like AAVE, Hypurr, AlphaFi."
          control={
            <ToggleSwitch
              checked={hydrated ? settings.transfersEnabled : true}
              onChange={updateTransfersEnabled}
              ariaLabel="Toggle fee transfers tracking"
            />
          }
        />
      </Card>

      <Card title="Data Management">
        <SettingRow
          label="Export All Data"
          description="Download all your positions, claims, transfers as a JSON backup file."
          control={
            <button
              type="button"
              onClick={handleExport}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
            >
              Export JSON
            </button>
          }
        />

        <Divider />

        <SettingRow
          label="Import from JSON"
          description="Restore from a previously exported JSON backup file."
          warning="This will replace ALL existing data."
          control={
            <>
              <button
                type="button"
                onClick={handleImportClick}
                className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
              >
                Import JSON
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={handleFileChosen}
                className="hidden"
              />
            </>
          }
        />
        {importState.kind !== "idle" && (
          <div
            className={`ml-0 rounded-md border px-3 py-2 text-xs ${
              importState.kind === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-rose-500/30 bg-rose-500/10 text-rose-300"
            }`}
            role="status"
          >
            {importState.message}
          </div>
        )}

        <Divider />

        <SettingRow
          label="Clear All Data"
          description="Permanently delete all positions, claims, transfers and ranges. This cannot be undone."
          control={
            pendingClear ? (
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <span className="text-xs text-[var(--muted)]">
                  Are you sure? This will delete everything and cannot be
                  undone.
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPendingClear(false)}
                    className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleClearAll}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-rose-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-rose-600/90"
                  >
                    Yes, Delete Everything
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPendingClear(true)}
                className="inline-flex h-9 items-center justify-center rounded-md border border-rose-500/30 bg-rose-500/10 px-4 text-sm font-medium text-rose-300 hover:bg-rose-500/20"
              >
                Clear All Data
              </button>
            )
          }
        />
      </Card>

      <Card title="CSV Export / Import">
        <div className="space-y-2">
          <div className="text-sm font-medium text-[var(--foreground)]">
            Export
          </div>
          <p className="text-xs text-[var(--muted)]">
            Download your data as CSV — one file per dataset.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={handleExportPositionsCsv}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
            >
              Export Positions CSV
            </button>
            <button
              type="button"
              onClick={handleExportClaimsCsv}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
            >
              Export Claims CSV
            </button>
            <button
              type="button"
              onClick={handleExportTransfersCsv}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
            >
              Export Transfers CSV
            </button>
          </div>
        </div>

        <Divider />

        <div className="space-y-2">
          <div className="text-sm font-medium text-[var(--foreground)]">
            Import
          </div>
          <p className="text-xs text-[var(--muted)]">
            Load positions from a previously exported CSV file.
          </p>
          <p className="text-xs font-medium text-amber-300">
            This will ADD to existing positions, not replace them.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={handleCsvImportClick}
              className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
            >
              Import Positions CSV
            </button>
            <input
              ref={csvFileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleCsvFileChosen}
              className="hidden"
            />
          </div>
          {csvImportState.kind !== "idle" && (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                csvImportState.kind === "success"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-300"
              }`}
              role="status"
            >
              {csvImportState.message}
            </div>
          )}
        </div>
      </Card>

      <Card title="About">
        <dl className="divide-y divide-[var(--border)]">
          <AboutRow label="App name" value="CLP Tracker" />
          <AboutRow label="Version" value={APP_VERSION} />
          <AboutRow
            label="Description"
            value="Built for DeFi LP position tracking. Standalone version — future integration with DefiDesh."
          />
          <AboutRow
            label="Storage"
            value="Data stored locally in your browser."
          />
        </dl>
      </Card>
    </section>
  );
}

interface CardProps {
  title: string;
  children: React.ReactNode;
}

function Card({ title, children }: CardProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="space-y-4 px-5 py-5">{children}</div>
    </div>
  );
}

interface SettingRowProps {
  label: string;
  description: string;
  warning?: string;
  control: React.ReactNode;
}

function SettingRow({ label, description, warning, control }: SettingRowProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-md">
        <div className="text-sm font-medium text-[var(--foreground)]">
          {label}
        </div>
        <p className="mt-1 text-xs text-[var(--muted)]">{description}</p>
        {warning && (
          <p className="mt-1 text-xs font-medium text-amber-300">{warning}</p>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-[var(--border)]" />;
}

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}

function ToggleSwitch({ checked, onChange, ariaLabel }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${
        checked
          ? "border-[var(--accent)] bg-[var(--accent-solid)]"
          : "border-[var(--border-strong)] bg-[var(--surface-2)]"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

interface AboutRowProps {
  label: string;
  value: string;
}

function AboutRow({ label, value }: AboutRowProps) {
  return (
    <div className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
        {label}
      </dt>
      <dd className="max-w-xl text-sm text-[var(--foreground)] sm:text-right">
        {value}
      </dd>
    </div>
  );
}
