# Scan-Mode Detail Navigation Fix (queue item 4)

**Date:** 2026-07-22
**Status:** Implemented, verified, **NOT committed** (awaiting confirmation).
**Scope:** platform-wide — every protocol, every chain. Not wrapper-specific.
**Verification:** local production build (`npm run build` + `npm run start`), Playwright
1.61.1, ephemeral clean profiles, no wallet extension.

---

## The bug

In **scan mode** (a wallet pasted via `?address=&chain=`, no watched/connected wallet),
clicking any position row navigated to `/dashboard/position/{id}` and rendered **"Position
not found"** with the navbar reading "no wallet". A pasted wallet could see its positions
but could not open a single one — on any protocol.

**Root cause:** row clicks use `window.location.href` (a FULL page load, not client-side
routing). `scanAddress` lives only in React state (`WatchedWalletsContext`), so the hard
navigation discarded it. The detail page then built its identity from connected+watched
wallets only, found nothing, and `positions.find(...)` returned `null`.

Found during Phase 2 Part 1 verification; confirmed pre-existing and universal (Raydium and
DefiTuna both reproduced it). Same class as the analytics scan-mode gap fixed in `e85f794`.

---

## The fix

Three coordinated pieces, all mirroring the established `e85f794` pattern.

**1. Carry scan identity through the row-click URL** (`app/dashboard/page.tsx`)
New `positionHref(slug)`: in scan mode appends `?address=&chain=`; otherwise returns the
bare path **byte-identical to before**. Both `window.location.href` call sites use it.

**2. Restore the scan on the detail page** (`app/dashboard/position/[id]/page.tsx`)
New `PositionScanModeListener` — a near-verbatim copy of `AnalyticsScanModeListener`. It
reads `?address=&chain=` and calls `setScanAddress`, so the hard-loaded detail page
re-enters scan mode and `PositionsContext` fetches the scanned wallet. Mounted in a
`<Suspense>` (Next 16 `useSearchParams()` requirement) on **all three** return paths —
loading, not-found, and main. The not-found mount is load-bearing: in scan mode the page
renders not-found on first paint (positions are empty until the scan is restored), so the
listener must run from inside that branch or the page can never recover.

**3. Preserve the scan on "Back to dashboard"** (`app/dashboard/position/[id]/page.tsx`)
New `backHref`: in scan mode carries the params, else `/dashboard` unchanged. All 3 back
links use it. Necessary because the DASHBOARD's own listener (unlike analytics/detail)
CLEARS `scanAddress` on absent params — it owns the scan banner and its [X] dismiss — so a
bare `/dashboard` href would drop the user's pasted wallet.

### Deliberate semantics
`PositionScanModeListener` matches `AnalyticsScanModeListener`, NOT the dashboard's:
**absent params do NOT clear an active scan.** Only the dashboard may clear a scan. This
keeps plain in-app navigation between scanned pages from wiping the scan.

---

## Verification

### ✅ The bug is fixed — scan mode, both protocols

| Protocol | Row value | Detail TOTAL VALUE | "Position not found" | URL carries scan |
|---|---|---|---|---|
| DefiTuna | $149.42 | **$149.42** | **false** | yes |
| Raydium | $20.94 | **$20.94** | **false** | yes |

Both render fully; detail TOTAL VALUE matches the dashboard row **exactly**. Screenshot
`scan-detail.png`: full DefiTuna detail page, navbar `SOL·SCAN 2rr3…JTpn`.

### ✅ Chain-generic + deep-link hard reload — Sui
`?chain=sui` scan → Cetus row $962.22 → detail TOTAL **$962.22**, not-found false. **Hard
reload of the detail URL** (not just in-app nav) also resolves to $962.22 — proving the
listener restores from the URL on a cold load, the strongest case.

### ✅ Back-navigation preserves the scan
After landing on a detail page in scan mode, "Back to dashboard" returns to a dashboard
that still has the scan banner, the scan URL params, and the positions visible. On Solana
and Sui.

### ✅ Non-scan mode completely unaffected (regression control)
Watched wallet (RAKA/A1), no scan:
- Detail URL: `/dashboard/position/orca-…` — **no query params** (hrefs byte-identical to before)
- All sections intact (Current Liquidity, Fee Claims History, Concentrated Liquidity Range, Performance Metrics)
- Row $4,213.36 vs detail $4,213.37 — 1¢ live-price drift (documented in Part 1), not a logic change
- Back link: **no params**, lands on populated dashboard

### ✅ Build
`npx tsc --noEmit` clean · `npm run build` clean.

---

## Files changed (2)

| File | Change |
|---|---|
| `app/dashboard/page.tsx` | `useCallback` import; `positionHref()` helper; both nav sites use it |
| `app/dashboard/position/[id]/page.tsx` | `PositionScanModeListener` + 3 `<Suspense>` mounts; `backHref`; 3 back links use it |

No other protocol's rendering path is touched. Nothing in the P&L / valuation pipeline
changed. No cache versions affected.

---

## Notes

- **A stale dev server on port 3000 initially masked the result** — the new build failed to
  bind (`EADDRINUSE`) and Playwright hit the OLD process, which showed a broken $0.00
  dashboard. Killed the stale PID, restarted clean, re-verified. Flagging because the first
  run's "no rows" output was a test-harness artifact, not a real regression — worth knowing
  the numbers above are from a confirmed-fresh server (`✓ Ready`, dashboard HTTP 200).
- The `aptos` chain exists in `WatchedWalletChain` but the listener validates only
  `evm|solana|sui` (matching the dashboard and analytics listeners exactly). When Aptos
  ships, all three listeners extend together — noted, not changed here.

**Not committed** — awaiting confirmation.
