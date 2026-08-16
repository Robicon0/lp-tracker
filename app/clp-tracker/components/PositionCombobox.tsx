"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { positionOptionLabel } from "./ClaimFormModal";
import { normalizeChain } from "../lib/nameNormalization";
import type { Position } from "../lib/types";

// How an option's annotation reads at a glance:
//   danger  — the money is gone (100% expensed)
//   success — settled but still working somewhere (transferred / deployed / a
//             mix that keeps some of it in play)
//   muted   — neutral context, not a state of that position's own money
export type NoteTone = "muted" | "danger" | "success";

// A note is a run of independently-coloured segments on ONE line, so a mixed
// breakdown can say "$100.00 expensed" in red and "$60.00 transferred" in green
// without splitting into two notes. Separators and punctuation live inside the
// segment text, which keeps the renderer dumb and the caller in full control of
// spacing (and sidesteps the JSX literal-space trimming that has bitten this
// file's copy twice).
export type PositionNote = { text: string; tone: NoteTone }[];

// Searchable, two-level-grouped position picker shared by the Fee Claims filter
// and the Add Transfer form. Type any of pair/chain/platform to filter live;
// positions are grouped by (normalized) chain, then split within each chain into
// Open Positions / Closed Positions (open first), each sorted most recent first.
// A sub-section renders only when it has members, so a chain holding only open
// (or only closed) positions shows no empty heading. `allValue` (optional) adds
// a clearable "all" entry — the Fee Claims filter uses it; Add Transfer omits it
// so a real position is required.
export function PositionCombobox({
  positions,
  value,
  onChange,
  label = "Position",
  allValue,
  allLabel = "All positions",
  placeholder = "— Select position —",
  noteFor,
  sortWithinSection,
}: {
  positions: Position[];
  value: string;
  onChange: (next: string) => void;
  label?: string;
  allValue?: string;
  allLabel?: string;
  placeholder?: string;
  // Optional per-position annotation (a memory aid, never a restriction).
  // Opt-in: callers that pass nothing render exactly as before, which is why
  // Fee Claims and Add Transfer are untouched by the Transfers page's notes.
  // Returns every annotation that applies, so unrelated hints (money spent vs
  // money already deployed here) can appear together rather than one hiding the
  // other. Empty array = no annotation.
  noteFor?: (p: Position) => PositionNote[];
  // Optional ordering INSIDE each chain's Open/Closed section. Default is
  // most-recent-first, which every existing caller keeps. Mark as Deployed
  // passes a date-proximity comparator so the nudge added in 9dd89d3 survives
  // the move onto this component — the grouping is the shared behaviour, the
  // order within a group is not.
  sortWithinSection?: (a: Position, b: Position) => number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selectedLabel = (() => {
    if (allValue !== undefined && value === allValue) return allLabel;
    const p = positions.find((pos) => pos.id === value);
    if (p) return positionOptionLabel(p);
    // "" means nothing chosen yet. That only reads as the all-entry when the
    // all-entry IS "" (the Fee Claims / Transfers filters, caught above); when
    // allValue is a real sentinel — Mark as Deployed's "Not sure which
    // position" — an empty value must still show the placeholder, not silently
    // claim the sentinel was picked.
    if (value === "") return placeholder;
    return allValue !== undefined ? allLabel : placeholder;
  })();

  // Chain (alphabetical) → Open then Closed → most-recent-first within each.
  // The search predicate is unchanged; it just runs before the grouping, so a
  // query narrows both sub-sections and drops any that end up empty.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = positions.filter((p) => {
      if (q === "") return true;
      return `${p.pair} ${p.chain} ${p.protocol}`.toLowerCase().includes(q);
    });
    const byChain = new Map<string, { open: Position[]; closed: Position[] }>();
    for (const p of matches) {
      const chain = normalizeChain(p.chain) || "OTHER";
      let entry = byChain.get(chain);
      if (!entry) {
        entry = { open: [], closed: [] };
        byChain.set(chain, entry);
      }
      // Anything not explicitly closed is treated as open, matching how every
      // other surface reads status (active is the only other stored value).
      if (p.status === "closed") entry.closed.push(p);
      else entry.open.push(p);
    }
    const byEntryDesc =
      sortWithinSection ??
      ((a: Position, b: Position) =>
        (new Date(b.entryDatetime).getTime() || 0) -
        (new Date(a.entryDatetime).getTime() || 0));
    return [...byChain.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([chain, entry]) => ({
        chain,
        // Open first. Empty sub-sections are dropped here rather than in the
        // markup, so a chain with only one status shows only that heading.
        sections: (
          [
            { key: "open", title: "Open Positions", list: entry.open },
            { key: "closed", title: "Closed Positions", list: entry.closed },
          ] as const
        )
          .filter((s) => s.list.length > 0)
          .map((s) => ({ ...s, list: [...s.list].sort(byEntryDesc) })),
      }));
  }, [positions, query, sortWithinSection]);

  const select = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  const isPlaceholder =
    value === "" || (allValue !== undefined && value === allValue);

  return (
    <div className="space-y-1.5" ref={ref}>
      <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </span>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-left text-sm focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        >
          <span
            className={`truncate ${
              isPlaceholder ? "text-[var(--muted)]" : "text-[var(--foreground)]"
            }`}
          >
            {selectedLabel}
          </span>
          <span className="shrink-0 text-[var(--muted)]">▾</span>
        </button>

        {open && (
          /* THE "BLEED-THROUGH" IS NOT A STACKING BUG — measured twice.
             elementFromPoint over a 11x11 grid inside the panel, at four scroll
             positions including the one from the bug report, returns the panel
             (or its children) at all 484 points: nothing paints above it, and
             the competing bulk-toolbar Platform input is position:static
             z-index:auto so it cannot. The actual cause is that the panel was
             painted in --surface (#111319) while the card it floats over is
             ALSO --surface (#111319) — byte-identical backgrounds, separated by
             one 1px border — and the panel is only ~549px wide inside a
             ~1152px card, so rows and toolbar controls continue at the same
             vertical positions immediately either side of it. Correct
             occlusion, zero visual separation: it reads as the page showing
             through, and shifts as you scroll past different content.
             Fix is contrast, not z-index: --surface-raised is deliberately
             lighter than both the card and the page, plus an explicit shadow
             (Tailwind's own shadow-* utilities render nothing in this project —
             `shadow-xl` computed to "rgba(0,0,0,0) 0px 0px 0px 0px") and a
             light edge ring. z-40 stays below the z-50 modal layer. */
          <div className="scrollbar-dark absolute z-40 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-[var(--border-strong)] bg-[var(--surface-raised)] shadow-[0_18px_45px_-8px_rgba(0,0,0,0.85)] ring-1 ring-white/10">
            {/* z-10 IS THE FIX, not decoration — measured. A sticky header with
                z-index:auto does not reliably paint above later-in-DOM siblings
                that scroll under it: at scrollTop 1600 of a 2652px list, 3 of 5
                hit-test points inside this header returned an option BUTTON
                instead, and a screenshot showed an option's text drawn straight
                across the search input. Setting z-index alone (nothing else
                changed) made all points pass at every scroll offset. The
                background must stay opaque for the same reason.
                Matches the panel, not the card — a --surface header on a
                --surface-raised panel would band across the top. */}
            <div className="sticky top-0 z-10 border-b border-[var(--border-strong)] bg-[var(--surface-raised)] p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pair, chain, or platform…"
                className="block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)]/60 focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
            {allValue !== undefined && (
              <button
                type="button"
                onClick={() => select(allValue)}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-white/10 ${
                  value === allValue
                    ? "text-[var(--accent)]"
                    : "text-[var(--foreground)]"
                }`}
              >
                {allLabel}
              </button>
            )}
            {groups.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-[var(--muted)]">
                No positions match “{query}”.
              </div>
            ) : (
              groups.map(({ chain, sections }) => (
                <div key={chain}>
                  <div className="bg-white/[0.06] px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                    {chain}
                  </div>
                  {sections.map((section) => (
                    <div key={section.key}>
                      <div className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]/70">
                        {section.title}
                      </div>
                      {section.list.map((p) => {
                        const notes = noteFor?.(p) ?? [];
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => select(p.id)}
                            className={`block w-full px-3 py-2 pl-5 text-left text-[13px] hover:bg-white/10 ${
                              value === p.id
                                ? "text-[var(--accent)]"
                                : "text-[var(--foreground)]"
                            } ${section.key === "closed" ? "opacity-75" : ""}`}
                          >
                            {positionOptionLabel(p)}
                            {notes.map((note, ni) => (
                              <span key={ni} className="ml-1">
                                <span className="text-[var(--muted)]">· </span>
                                {note.map((seg, si) => (
                                  <span
                                    key={si}
                                    className={
                                      seg.tone === "danger"
                                        ? "font-medium text-rose-400"
                                        : seg.tone === "success"
                                          ? "font-medium text-emerald-400"
                                          : "text-[var(--muted)]"
                                    }
                                  >
                                    {seg.text}
                                  </span>
                                ))}
                              </span>
                            ))}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
