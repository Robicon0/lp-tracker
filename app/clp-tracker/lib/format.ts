import { useSyncExternalStore } from "react";

// The ONE place the CLP Tracker formats money and token quantities, and the
// owner of the "Hide numbers" privacy mode. Every page and component imports
// its formatters from here; scripts/clp-format-guard-test.ts fails the build
// check if a currency Intl.NumberFormat appears anywhere else in the section.
//
// Privacy mode: when on, every USD amount and token QUANTITY formatter returns
// MASK instead. Prices (formatUsdPrice, formatPrice in positionFormUtils),
// percentages, dates and names are never masked. Nothing stored, calculated
// or exported changes: CSV / JSON backups still carry the real numbers.

export const MASK = "••••";

const STORAGE_KEY = "clp_privacy_mode";

// Starts false and is read from storage only when the first component
// subscribes (a passive effect, after hydration) or asks for the client
// snapshot outside hydration. That keeps the hydration render identical to the
// server render: the server never knows the choice.
let hidden = false;
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    hidden = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Storage blocked: the mode still works for this page view, unsaved.
    hidden = false;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent): void {
  if (e.key !== STORAGE_KEY) return;
  const next = e.newValue === "1";
  if (next === hidden) return;
  hidden = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  load();
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function getSnapshot(): boolean {
  load();
  return hidden;
}

function getServerSnapshot(): boolean {
  return false;
}

export function isPrivacyMode(): boolean {
  return hidden;
}

export function setPrivacyMode(next: boolean): void {
  load();
  if (next === hidden) return;
  hidden = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Storage blocked: keep the in-memory choice for this page view.
  }
  emit();
}

/** Subscribe a component to the privacy mode. Call it in every component
 *  that formats money, so a toggle re-renders it even when its parent does
 *  not (and so any useMemo that builds formatted text can list it as a dep). */
export function usePrivacyMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Mask an already-built amount string (raw quantities in tooltips etc.). */
export function hideAmount(text: string): string {
  return hidden ? MASK : text;
}

/** Free text a user typed (notes): when hidden, every dollar amount in it
 *  ("$1,234.56", "-$5") becomes the mask. Bare numbers are left alone: a note
 *  can hold dates, tick counts or tx fragments that are not amounts. */
export function maskAmountsInText(text: string): string {
  if (!hidden) return text;
  return text.replace(/-?\$\s?-?[\d,]+(?:\.\d+)?/g, MASK);
}

/** A computed sentence whose every number is an amount (e.g. "Only 12.5 SUI
 *  is unconverted"): when hidden, every number in it becomes the mask. */
export function maskNumbersInText(text: string): string {
  if (!hidden) return text;
  return text.replace(/-?\$?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?/gi, MASK);
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// A needed price can land far outside the 2dp range a dollar total lives in,
// so prices keep up to 6 decimals. A price is not an amount: never masked.
const usdPriceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const tokenFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const tokenCountFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 6,
});

export function formatUsd(value: number): string {
  if (hidden) return MASK;
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

/** USD for text that is STORED (e.g. a note stamp): never masked. */
export function formatUsdExact(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

/** Like formatUsd, with a leading "+" on a gain. Masked: the bare mask. */
export function formatSignedUsd(value: number): string {
  if (hidden) return MASK;
  return value > 0 ? `+${formatUsd(value)}` : formatUsd(value);
}

/** USD with no finite guard (the old direct usdFormatter.format calls). */
export function formatUsdRaw(value: number): string {
  if (hidden) return MASK;
  return usdFormatter.format(value);
}

export function formatUsdPrice(value: number): string {
  return usdPriceFormatter.format(Number.isFinite(value) ? value : 0);
}

/** Token quantity, 2 to 6 decimals. */
export function formatToken(value: number): string {
  if (hidden) return MASK;
  return tokenFormatter.format(Number.isFinite(value) ? value : 0);
}

/** Token quantity, 0 to 6 decimals (transfer amounts). */
export function formatTokenCount(value: number): string {
  if (hidden) return MASK;
  return tokenCountFormatter.format(Number.isFinite(value) ? value : 0);
}

/** Token quantity via toLocaleString, no finite guard (positionFormUtils'
 *  old fmtTokenAmount, kept byte-identical). */
export function formatTokenUnguarded(value: number): string {
  if (hidden) return MASK;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}
