"use client";

import {
  type ReactNode,
} from "react";

export interface DateTimeFieldsProps {
  dateLabel: string;
  timeLabel: string;
  idPrefix: string;
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
}


export function DateTimeFields({
  dateLabel,
  timeLabel,
  idPrefix,
  value,
  onChange,
  required,
}: DateTimeFieldsProps) {
  const [d = "", t = ""] = (value || "").split("T");
  const [hStr = "", mStr = ""] = (t || "").split(":");
  const dateId = `${idPrefix}-date`;
  const hourId = `${idPrefix}-hour`;
  const minId = `${idPrefix}-min`;

  const pad2 = (n: number) => String(n).padStart(2, "0");

  const setDate = (newDate: string) => {
    onChange(`${newDate}T${hStr || "00"}:${mStr || "00"}`);
  };
  const setHour = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(-2);
    const n =
      digits === ""
        ? 0
        : Math.max(0, Math.min(23, Number.parseInt(digits, 10) || 0));
    onChange(`${d}T${pad2(n)}:${mStr || "00"}`);
  };
  const setMin = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(-2);
    const n =
      digits === ""
        ? 0
        : Math.max(0, Math.min(59, Number.parseInt(digits, 10) || 0));
    onChange(`${d}T${hStr || "00"}:${pad2(n)}`);
  };

  return (
    <>
      <Field label={dateLabel} htmlFor={dateId}>
        <div suppressHydrationWarning>
          <input
            id={dateId}
            type="date"
            required={required}
            className={inputClass}
            style={{ colorScheme: "dark" }}
            value={d}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </Field>
      <Field
        label={timeLabel}
        htmlFor={hourId}
        hint="24hr format — e.g. 13:44"
      >
        <div className="flex items-center gap-2" suppressHydrationWarning>
          <input
            id={hourId}
            type="number"
            min={0}
            max={23}
            placeholder="HH"
            required={required}
            className={`${inputClass} w-[70px] text-center`}
            style={{ colorScheme: "dark" }}
            value={hStr}
            onChange={(e) => setHour(e.target.value)}
            aria-label={`${timeLabel} hour`}
          />
          <span className="text-[var(--muted)]" aria-hidden>
            :
          </span>
          <input
            id={minId}
            type="number"
            min={0}
            max={59}
            placeholder="MM"
            required={required}
            className={`${inputClass} w-[70px] text-center`}
            style={{ colorScheme: "dark" }}
            value={mStr}
            onChange={(e) => setMin(e.target.value)}
            aria-label={`${timeLabel} minute`}
          />
        </div>
      </Field>
    </>
  );
}


export interface FieldProps {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}


export function Field({ label, htmlFor, children, hint }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]"
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-[var(--muted)]">{hint}</p>}
    </div>
  );
}


// Plausibility warning (Invariant #8): exit before entry is impossible but
// was silently accepted — Days Active clamps to 0 and APR reads 0%. Warns
// without blocking so users can still correct whichever date is wrong.
export function DateOrderWarning({
  entry,
  exit,
}: {
  entry: string;
  exit: string | null | undefined;
}) {
  if (!entry || !exit) return null;
  const entryMs = new Date(entry).getTime();
  const exitMs = new Date(exit).getTime();
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs)) return null;
  if (exitMs >= entryMs) return null;
  return (
    <p className="text-xs font-medium text-amber-400 sm:col-span-2">
      ⚠ Exit date is earlier than entry date — Days Active will count as 0 and
      Fee APR will show 0%. Please check the dates.
    </p>
  );
}


export const inputClass =
  "block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)]/60 [color-scheme:dark] caret-[var(--accent)] focus:border-[var(--accent)] focus:bg-[var(--surface-2)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";


export interface SectionProps {
  title: string;
  children: ReactNode;
}


export function Section({ title, children }: SectionProps) {
  return (
    <div className="px-5 py-5">
      <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
        {title}
      </h3>
      {children}
    </div>
  );
}


export interface FormActionsProps {
  onCancel: () => void;
  submitLabel: string;
  submitTone?: "primary" | "danger";
}


export function FormActions({
  onCancel,
  submitLabel,
  submitTone = "primary",
}: FormActionsProps) {
  const submitClass =
    submitTone === "danger"
      ? "bg-rose-600 hover:bg-rose-600/90 text-white"
      : "bg-[var(--accent-solid)] hover:bg-[var(--accent-solid)]/90 text-white";
  return (
    <div className="flex justify-end gap-2 px-5 py-4">
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
      >
        Cancel
      </button>
      <button
        type="submit"
        className={`inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium shadow-sm transition-colors ${submitClass}`}
      >
        {submitLabel}
      </button>
    </div>
  );
}
