'use client';

import { useState, useEffect } from 'react';
import { TOKEN_LOGOS } from '../lib/tokenLogos';

/**
 * Token art comes from the shared platform map, NOT a private copy.
 *
 * This page used to carry its own TOKEN_IMAGES, which is exactly the
 * per-route hardcoded token map architecture Rule 9 forbids — and it
 * demonstrated why: its HYPE entry pointed at CoinGecko image id 37880 on
 * assets.coingecko.com, which now answers 403 with an application/xml error
 * body. Chrome's Opaque Response Blocking rejects that (XML served where an
 * image was expected), so the logo failed for every visitor. tokenLogos.ts had
 * already been corrected to id 50882 on coin-images.coingecko.com; the private
 * copy simply never received the fix. Importing the shared map means the next
 * such correction lands here for free.
 */

const COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  SOL: 'solana',
  SUI: 'sui',
  HYPE: 'hyperliquid',
  USDC: 'usd-coin',
  USDT: 'tether',
};

const IL_PAIRS = [
  { n: 'ETH/USDC', t0: 'ETH', t1: 'USDC', p0: 2500, p1: 1 },
  { n: 'BTC/USDC', t0: 'BTC', t1: 'USDC', p0: 97000, p1: 1 },
  { n: 'SOL/USDC', t0: 'SOL', t1: 'USDC', p0: 180, p1: 1 },
  { n: 'SUI/USDC', t0: 'SUI', t1: 'USDC', p0: 3.2, p1: 1 },
  { n: 'HYPE/USDC', t0: 'HYPE', t1: 'USDC', p0: 25, p1: 1 },
];

const HG_PRESETS = [
  { v: 'BTC', p: 97000, d: 1000, l: -5, u: 5 },
  { v: 'ETH', p: 2500, d: 1000, l: -5, u: 5 },
  { v: 'SOL', p: 180, d: 1000, l: -5, u: 5 },
  { v: 'SUI', p: 3.2, d: 1000, l: -5, u: 5 },
  { v: 'HYPE', p: 25, d: 1000, l: -5, u: 5 },
];

function fmt(n: number, d = 4): string {
  if (n == null || isNaN(n)) return '0.0000';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  if (Math.abs(n) < 0.0001 && d <= 4) return '0.0000';
  return n.toFixed(d);
}

function fmtHG(n: number, d = 2): string {
  if (n == null || isNaN(n)) return '0.00';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  if (Math.abs(n) < 0.01 && d <= 2) return '0.00';
  return n.toFixed(d);
}

function fmtT(n: number): string {
  if (Math.abs(n) < 0.000001 && n !== 0) return n.toExponential(4);
  if (Math.abs(n) < 1) return n.toFixed(6);
  return fmt(n, 4);
}

function TokenIcon({ symbol, size = 22 }: { symbol: string; size?: number }) {
  const s = (symbol || '?').toUpperCase();
  // Shared map is keyed mixed-case for a few entries (cbBTC, USDC.e), so fall
  // back to a case-insensitive lookup before giving up to the letter avatar.
  const imgUrl =
    TOKEN_LOGOS[s] ??
    TOKEN_LOGOS[Object.keys(TOKEN_LOGOS).find(k => k.toUpperCase() === s) ?? ''];
  const [imgError, setImgError] = useState(false);
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', background: 'linear-gradient(135deg,var(--chain-arbitrum),var(--chain-polygon))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {imgUrl && !imgError ? (
        <img src={imgUrl} alt={s} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgError(true)} />
      ) : (
        <span style={{ fontSize: size * 0.4, fontWeight: 700, color: 'var(--fg)' }}>{s[0]}</span>
      )}
    </div>
  );
}

function calcIL(il: any) {
  const cr = il.p0 / il.p1, fr = il.f0 / il.f1;
  const lp = cr * (1 + il.lb / 100), up = cr * (1 + il.ub / 100);
  const inR = fr >= lp && fr <= up;
  const spa = Math.sqrt(lp), spb = Math.sqrt(up), sp0 = Math.sqrt(cr), sp1 = Math.sqrt(fr);
  const t0pL = Math.max(0, 1 / sp0 - 1 / spb), t1pL = Math.max(0, sp0 - spa);
  const vpL = t0pL * cr + t1pL, L = vpL > 0 ? il.inv / vpL : 0;
  const it0 = L * t0pL, it1 = L * t1pL;
  const hv0 = it0 * il.f0, hv1 = it1 * il.f1, hodl = hv0 + hv1;
  let ft0, ft1;
  if (fr <= lp) { ft0 = L * (1 / spa - 1 / spb); ft1 = 0; }
  else if (fr >= up) { ft0 = 0; ft1 = L * (spb - spa); }
  else { ft0 = L * (1 / sp1 - 1 / spb); ft1 = L * (sp1 - spa); }
  const apr = il.dy * 365, yPct = il.dy * il.days;
  const fv0 = ft0 * il.f0, fv1 = ft1 * il.f1, lpT = fv0 + fv1;
  const yE = il.inv * (yPct / 100), lpWY = lpT + yE;
  const ilD = lpT - hodl, ilP = hodl > 0 ? (ilD / hodl) * 100 : 0;
  const dYD = (apr / 100 / 365) * il.inv, dtc = dYD > 0 ? Math.abs(ilD) / dYD : 99999;
  const hPct = (hodl - il.inv) / il.inv * 100, lpPct = (lpWY - il.inv) / il.inv * 100;
  return { lp, up, cr, fr, inR, it0, it1, hv0, hv1, hodl, ft0, ft1, fv0, fv1, lpT, lpWY, yE, ilD, ilP, apr, yPct, dtc, hPct, lpPct };
}

function calcHG(hg: any) {
  if (hg.pr <= 0 || hg.dep <= 0) return null;
  const lp = hg.pr * (1 + hg.lb / 100), up = hg.pr * (1 + hg.ub / 100);
  if (lp <= 0 || up <= 0 || lp >= up) return null;
  const sqP = Math.sqrt(hg.pr), spa = Math.sqrt(lp), spb = Math.sqrt(up);
  const ePL = 1 / sqP - 1 / spb, uPL = sqP - spa;
  const vPL = ePL * hg.pr + uPL, L = hg.dep / vPL;
  const cE = L * ePL, cU = L * uPL, cEV = cE * hg.pr;
  const eAtL = L * (1 / spa - 1 / spb), lpPnlL = eAtL * lp - hg.dep;
  const hSz = -lpPnlL / (hg.pr - lp), hVal = hSz * hg.pr;
  const lo = [1, 2, 3, 5, 10].map(lv => {
    const mR = hVal / lv;
    const liqP = hg.pr * (1 + 0.95 / lv);
    const liqPct = (liqP - hg.pr) / hg.pr * 100;
    const tC = hg.dep + mR;
    // FIXED: Stop loss = price where total capital loss hits 2%
    const maxLoss = tC * 0.02;
    const slP = hg.pr + (maxLoss / hSz);
    const slPct = (slP - hg.pr) / hg.pr * 100;
    const buf = (liqP - slP) / (liqP - hg.pr) * 100;
    return { lv, mR, liqP, liqPct, slP, slPct, buf, tC, capEff: hg.dep / tC * 100, maxLoss };
  });
  const calcOut = (nP: number) => {
    const nSqP = Math.sqrt(nP);
    let lpV;
    if (nP <= lp) lpV = L * (1 / spa - 1 / spb) * nP;
    else if (nP >= up) lpV = L * (spb - spa);
    else lpV = L * (1 / nSqP - 1 / spb) * nP + L * (nSqP - spa);
    const lpPnl = lpV - hg.dep, hPnl = hSz * (hg.pr - nP);
    return { pr: nP, lpPnl, hPnl, net: lpPnl + hPnl, netPct: (lpPnl + hPnl) / hg.dep * 100 };
  };
  return { lp, up, cE, cU, cEV, hSz, hVal, lo, calcOut };
}

async function fetchTokenPrice(symbol: string): Promise<number | null> {
  const s = symbol.toUpperCase();
  const knownId = COINGECKO_IDS[s];
  try {
    if (knownId) {
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${knownId}&vs_currencies=usd`);
      const d = await r.json();
      return d[knownId]?.usd || null;
    } else {
      const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
      const d = await r.json();
      if (d?.coins?.[0]) {
        const id = d.coins[0].id;
        const r2 = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
        const d2 = await r2.json();
        return d2[id]?.usd || null;
      }
    }
  } catch { }
  return null;
}

export default function LPCalculatorPage() {
  const [tab, setTab] = useState<'il' | 'hg'>('il');
  const [il, setIL] = useState({
    t0: 'ETH', t1: 'USDC', p0: 2500, p1: 1, f0: 2375, f1: 1,
    inv: 1000, lb: -5, ub: 5, dy: 0.30, days: 7, pair: 'ETH/USDC'
  });
  const [hg, setHG] = useState({
    dep: 1000, pr: 2500, vs: 'ETH', ss: 'USDC',
    lb: -5, ub: 5, lev: 2, fr: 10, ly: 120
  });

  // Custom token state for IL
  const [ilCustom, setILCustom] = useState(false);
  const [ilCustomT0, setILCustomT0] = useState('');
  const [ilCustomT1, setILCustomT1] = useState('');
  const [ilFetchingPrice, setILFetchingPrice] = useState(false);

  // Custom token state for HG
  const [hgCustom, setHGCustom] = useState(false);
  const [hgFetchingPrice, setHGFetchingPrice] = useState(false);

  // Fetch live prices on load
  useEffect(() => {
    const ids = 'ethereum,bitcoin,solana,sui,hyperliquid';
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)
      .then(r => r.json())
      .then(data => {
        if (data?.ethereum?.usd) {
          const p = data.ethereum.usd;
          setIL(prev => ({ ...prev, p0: p, f0: +(p * 0.95).toFixed(2) }));
          setHG(prev => ({ ...prev, pr: p }));
        }
      }).catch(() => { });
  }, []);

  // Fetch custom IL token prices
  const handleILCustomTokenChange = async (t0: string, t1: string) => {
    setILCustomT0(t0);
    setILCustomT1(t1);
    if (t0.length >= 2) {
      setILFetchingPrice(true);
      const p0 = await fetchTokenPrice(t0);
      if (p0) setIL(prev => ({ ...prev, t0: t0.toUpperCase(), p0, f0: +(p0 * 0.95).toFixed(2) }));
      else setIL(prev => ({ ...prev, t0: t0.toUpperCase() }));
      setILFetchingPrice(false);
    }
    if (t1.length >= 2) {
      const p1 = await fetchTokenPrice(t1);
      if (p1) setIL(prev => ({ ...prev, t1: t1.toUpperCase(), p1, f1: p1 }));
      else setIL(prev => ({ ...prev, t1: t1.toUpperCase() }));
    }
  };

  // Fetch custom HG token price
  const handleHGCustomToken = async (symbol: string) => {
    setHG(prev => ({ ...prev, vs: symbol.toUpperCase() }));
    if (symbol.length >= 2) {
      setHGFetchingPrice(true);
      const p = await fetchTokenPrice(symbol);
      if (p) setHG(prev => ({ ...prev, pr: p }));
      setHGFetchingPrice(false);
    }
  };

  const ilC = calcIL(il);
  const hgC = calcHG(hg);
  const hgLD = hgC?.lo.find(l => l.lv === hg.lev);

  const card = "bg-surface border border-line rounded-2xl p-4 sm:p-5 mb-4";
  const inp = "bg-surface-2 border border-line rounded-xl px-3 py-2 text-fg font-mono text-sm w-full min-w-0 outline-none focus:border-accent/50";
  const lbl = "text-fg-muted text-xs font-medium uppercase mb-1.5 flex items-center gap-1.5";
  const btn = "px-2.5 sm:px-3 py-2 rounded-xl border border-line bg-surface text-fg-muted text-xs cursor-pointer hover:bg-surface-hover hover:text-fg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap";

  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">

        {/* Header */}
        <div className="text-center mb-8 sm:mb-9">
          <h1 className="text-3xl sm:text-4xl font-bold mb-2">LP Calculator</h1>
          <p className="text-fg-subtle text-sm">Impermanent Loss &amp; Hedging Analytics</p>
        </div>

        {/* Tabs — stack on mobile so the labels never have to wrap mid-word */}
        <div className="flex flex-col sm:flex-row gap-1 bg-surface border border-line rounded-2xl p-1 mb-6 sm:mb-7">
          <button onClick={() => setTab('il')} className={`flex-1 py-3 sm:py-3.5 px-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${tab === 'il' ? 'bg-accent/20 text-fg shadow-lg' : 'text-fg-muted hover:text-fg'}`}>
            📉 Impermanent Loss Calculator
          </button>
          <button onClick={() => setTab('hg')} className={`flex-1 py-3 sm:py-3.5 px-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${tab === 'hg' ? 'bg-accent/20 text-fg shadow-lg' : 'text-fg-muted hover:text-fg'}`}>
            🛡️ Hedging Calculator
          </button>
        </div>

        {/* ==================== IL TAB ==================== */}
        {tab === 'il' && (
          <div>
            {/* Strategy Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div className={card}>
                <div className="flex flex-wrap justify-between items-center gap-x-3 gap-y-1 mb-3">
                  <span className="text-fg-muted text-xs">Strategy A: Withdraw &amp; HODL</span>
                  <div className="flex items-baseline gap-2 ml-auto">
                    <span className={`text-sm font-semibold ${ilC.hPct >= 0 ? 'text-pos' : 'text-neg'}`}>{ilC.hPct >= 0 ? '+' : ''}{fmt(ilC.hPct, 3)}%</span>
                    <span className="text-lg font-bold font-mono">${fmt(ilC.hodl, 2)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 mb-2 min-w-0">
                  <TokenIcon symbol={il.t0} /><span className="text-sm shrink-0">{il.t0}</span>
                  <span className="ml-auto font-mono text-sm truncate">{fmtT(ilC.it0)}</span>
                  <span className="text-fg-subtle text-xs shrink-0">(${fmt(ilC.hv0, 2)})</span>
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <TokenIcon symbol={il.t1} /><span className="text-sm shrink-0">{il.t1}</span>
                  <span className="ml-auto font-mono text-sm truncate">{fmtT(ilC.it1)}</span>
                  <span className="text-fg-subtle text-xs shrink-0">(${fmt(ilC.hv1, 2)})</span>
                </div>
              </div>
              <div className="bg-pos/10 border border-pos/30 rounded-2xl p-4 sm:p-5 mb-4">
                <div className="flex flex-wrap justify-between items-center gap-x-3 gap-y-2 mb-3">
                  <span className="text-xs px-2 py-1 rounded-md bg-pos/15 border border-pos/30 text-pos font-semibold">Strategy B: Keep Liquidity</span>
                  <div className="flex items-baseline gap-2 ml-auto">
                    <span className={`text-sm font-semibold ${ilC.lpPct >= 0 ? 'text-pos' : 'text-neg'}`}>{ilC.lpPct >= 0 ? '+' : ''}{fmt(ilC.lpPct, 3)}%</span>
                    <span className="text-lg font-bold font-mono">${fmt(ilC.lpWY, 2)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 mb-2 min-w-0">
                  <TokenIcon symbol={il.t0} /><span className="text-sm shrink-0">{il.t0}</span>
                  <span className="ml-auto font-mono text-sm truncate">{fmtT(ilC.ft0)}</span>
                  <span className="text-fg-subtle text-xs shrink-0">(${fmt(ilC.fv0, 2)})</span>
                </div>
                <div className="flex items-center gap-2 mb-3 min-w-0">
                  <TokenIcon symbol={il.t1} /><span className="text-sm shrink-0">{il.t1}</span>
                  <span className="ml-auto font-mono text-sm truncate">{fmtT(ilC.ft1)}</span>
                  <span className="text-fg-subtle text-xs shrink-0">(${fmt(ilC.fv1, 2)})</span>
                </div>
                <div className="border-t border-line pt-2.5">
                  <div className="flex justify-between gap-2 text-xs mb-1"><span className="text-fg-muted shrink-0">LP Yield ({il.days}d)</span><span className="text-pos font-semibold text-right">{fmt(ilC.yPct, 2)}% (${fmt(ilC.yE)})</span></div>
                  <div className="flex justify-between gap-2 text-xs"><span className="text-fg-muted shrink-0">Impermanent Loss</span><span className="text-neg font-semibold text-right">{fmt(ilC.ilP)}% -${fmt(Math.abs(ilC.ilD))}</span></div>
                </div>
              </div>
            </div>

            {/* Pair Selector */}
            <div className={`${card} py-3.5 px-4`}>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-fg-muted text-xs font-semibold uppercase">Pair</span>
                {IL_PAIRS.map(p => (
                  <button key={p.n} onClick={async () => {
                    setILCustom(false);
                    const price = await fetchTokenPrice(p.t0);
                    const p0 = price || p.p0;
                    setIL(prev => ({ ...prev, pair: p.n, t0: p.t0, t1: p.t1, p0, p1: p.p1, f0: +(p0 * 0.95).toFixed(2), f1: p.p1 }));
                  }} className={`${btn} ${il.pair === p.n && !ilCustom ? 'border-accent/40 bg-accent/15 text-accent' : ''}`}>
                    <TokenIcon symbol={p.t0} size={16} /><TokenIcon symbol={p.t1} size={16} /><span className="ml-1">{p.n}</span>
                  </button>
                ))}
                {/* Custom Button */}
                <button onClick={() => { setILCustom(true); setIL(prev => ({ ...prev, pair: 'Custom' })); }} className={`${btn} ${ilCustom ? 'border-accent/40 bg-accent/15 text-accent' : ''}`}>
                  ✦ Custom
                </button>
                <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2">
                  <span className="text-fg-muted text-xs shrink-0">Investment</span>
                  <input type="number" value={il.inv} onChange={e => setIL(prev => ({ ...prev, inv: parseFloat(e.target.value) || 0 }))} className={`${inp} w-full sm:w-[100px]`} />
                  {[1000, 5000, 10000].map(v => <button key={v} onClick={() => setIL(prev => ({ ...prev, inv: v }))} className={btn}>${v >= 1000 ? v / 1000 + 'k' : v}</button>)}
                </div>
              </div>

              {/* Custom Token Inputs */}
              {ilCustom && (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4 border-t border-line">
                  <div>
                    <label className={lbl}>Token 0 Symbol</label>
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="e.g. ETH, SOL, BTC"
                        value={ilCustomT0}
                        onChange={e => handleILCustomTokenChange(e.target.value, ilCustomT1)}
                        className={inp}
                        style={{ textTransform: 'uppercase' }}
                      />
                      {ilFetchingPrice && <span className="absolute right-3 top-2.5 text-xs text-warn">fetching...</span>}
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Token 1 Symbol</label>
                    <input
                      type="text"
                      placeholder="e.g. USDC, BTC, ETH"
                      value={ilCustomT1}
                      onChange={e => handleILCustomTokenChange(ilCustomT0, e.target.value)}
                      className={inp}
                      style={{ textTransform: 'uppercase' }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Prices */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className={card}>
                <h3 className="text-sm font-semibold mb-3">Current Price</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={lbl}><TokenIcon symbol={il.t0} size={14} />{il.t0}</label><input type="number" value={il.p0} onChange={e => setIL(prev => ({ ...prev, p0: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                  <div><label className={lbl}><TokenIcon symbol={il.t1} size={14} />{il.t1}</label><input type="number" value={il.p1} onChange={e => setIL(prev => ({ ...prev, p1: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                </div>
              </div>
              <div className={card}>
                <h3 className="text-sm font-semibold mb-3">Future Price</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={lbl}><TokenIcon symbol={il.t0} size={14} />{il.t0}</label><input type="number" value={il.f0} onChange={e => setIL(prev => ({ ...prev, f0: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                  <div><label className={lbl}><TokenIcon symbol={il.t1} size={14} />{il.t1}</label><input type="number" value={il.f1} onChange={e => setIL(prev => ({ ...prev, f1: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                </div>
              </div>
            </div>

            {/* Range */}
            <div className={card}>
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-sm font-semibold">Liquidity Range</h3>
                <span className={`px-2.5 py-1 rounded-md text-xs font-semibold ${ilC.inR ? 'bg-pos/15 border border-pos/30 text-pos' : 'bg-neg/15 border border-neg/30 text-neg'}`}>{ilC.inR ? 'In Range' : 'Out of Range'}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs mb-3">
                <span className="text-info order-1">${fmt(ilC.lp)}</span>
                <span className="text-info order-2 sm:order-3">${fmt(ilC.up)}</span>
                <span className="text-fg-muted order-3 sm:order-2 w-full sm:w-auto text-center">Current: ${fmt(ilC.cr)} | <span className="text-warn">Future: ${fmt(ilC.fr)}</span></span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                <div><label className={lbl}>Lower %</label><input type="number" step="0.1" value={il.lb} onChange={e => setIL(prev => ({ ...prev, lb: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                <div><label className={lbl}>Lower Price</label><input type="number" value={+(ilC.lp).toFixed(2)} onChange={e => { const p = parseFloat(e.target.value); if (p > 0) setIL(prev => ({ ...prev, lb: ((p - prev.p0) / prev.p0) * 100 })); }} className={inp} /></div>
                <div><label className={lbl}>Upper %</label><input type="number" step="0.1" value={il.ub} onChange={e => setIL(prev => ({ ...prev, ub: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                <div><label className={lbl}>Upper Price</label><input type="number" value={+(ilC.up).toFixed(2)} onChange={e => { const p = parseFloat(e.target.value); if (p > 0) setIL(prev => ({ ...prev, ub: ((p - prev.p0) / prev.p0) * 100 })); }} className={inp} /></div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[5, 10, 20, 50].map(r => <button key={r} onClick={() => setIL(prev => ({ ...prev, lb: -r, ub: r }))} className={btn}>±{r}%</button>)}
                <span className="ml-auto text-fg-subtle text-xs self-center">{fmt(il.ub - il.lb)}% width</span>
              </div>
            </div>

            {/* Days & Yield */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className={card}>
                <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
                  <h3 className="text-sm font-semibold">Days Active</h3>
                  <div className="flex items-center gap-2 ml-auto">
                    <button onClick={() => setIL(prev => ({ ...prev, days: Math.max(1, prev.days - 1) }))} className={btn}>−</button>
                    <input type="number" value={il.days} onChange={e => setIL(prev => ({ ...prev, days: parseInt(e.target.value) || 1 }))} className={`${inp} w-[60px] text-center`} />
                    <button onClick={() => setIL(prev => ({ ...prev, days: prev.days + 1 }))} className={btn}>+</button>
                  </div>
                </div>
                <div className={`p-3 rounded-xl text-xs ${ilC.dtc <= il.days ? 'bg-pos/10 border border-pos/30 text-pos' : 'bg-warn/10 border border-warn/30 text-warn'}`}>
                  {ilC.dtc <= il.days ? `✅ Position covers IL after ${fmt(ilC.dtc, 1)} days` : `Position needs ≥${fmt(ilC.dtc, 1)}d to cover IL`}
                </div>
                <div className="grid grid-cols-6 gap-1.5 mt-3">
                  {[{ d: 1, l: '1d' }, { d: 7, l: '1w' }, { d: 14, l: '2w' }, { d: 30, l: '1m' }, { d: 90, l: '3m' }, { d: 365, l: '1y' }].map(x => (
                    <button key={x.d} onClick={() => setIL(prev => ({ ...prev, days: x.d }))} className={btn}>{x.l}</button>
                  ))}
                </div>
              </div>
              <div className={card}>
                <h3 className="text-sm font-semibold mb-3">LP Yield</h3>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div><label className={lbl}>Daily Yield (%)</label><input type="number" step="0.01" value={il.dy} onChange={e => setIL(prev => ({ ...prev, dy: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                  <div><label className={lbl}>Yearly APR (%)</label><input type="number" value={(il.dy * 365).toFixed(1)} readOnly className={`${inp} opacity-60 cursor-not-allowed`} /></div>
                </div>
                <div className="grid grid-cols-5 gap-1.5 mb-3">
                  {[0.1, 0.2, 0.3, 0.5, 1.0].map(y => <button key={y} onClick={() => setIL(prev => ({ ...prev, dy: y }))} className={btn}>{y}%</button>)}
                </div>
                <div className="flex justify-between px-3 py-2 bg-pos/10 rounded-lg text-xs">
                  <span className="text-fg-muted">{il.days}d yield:</span>
                  <span className="text-pos font-semibold">{fmt(ilC.yPct, 2)}% (${fmt(ilC.yE)})</span>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { l: 'Investment', v: `$${fmt(il.inv, 2)}`, c: 'text-fg' },
                { l: 'HODL Value', v: `$${fmt(ilC.hodl, 2)}`, c: ilC.hPct >= 0 ? 'text-pos' : 'text-neg' },
                { l: 'LP + Yield', v: `$${fmt(ilC.lpWY, 2)}`, c: ilC.lpPct >= 0 ? 'text-pos' : 'text-neg' },
                { l: 'IL', v: `${fmt(ilC.ilP)}%`, c: 'text-neg' },
              ].map(s => (
                <div key={s.l} className={card + ' text-center py-3.5'}>
                  <div className="text-fg-muted text-xs uppercase mb-1.5">{s.l}</div>
                  <div className={`text-base font-bold font-mono ${s.c}`}>{s.v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ==================== HG TAB ==================== */}
        {tab === 'hg' && hgC && hgLD && (
          <div>
            {/* Presets */}
            <div className="flex gap-2 flex-wrap mb-4">
              {HG_PRESETS.map(p => (
                <button key={p.v} onClick={async () => {
                  setHGCustom(false);
                  const price = await fetchTokenPrice(p.v);
                  setHG(prev => ({ ...prev, vs: p.v, ss: 'USDC', pr: price || p.p, dep: p.d, lb: p.l, ub: p.u }));
                }} className={`${btn} ${hg.vs === p.v && !hgCustom ? 'border-accent/40 bg-accent/15 text-accent' : ''}`}>
                  <TokenIcon symbol={p.v} size={16} /><TokenIcon symbol="USDC" size={16} /><span className="ml-1">{p.v}/USDC</span>
                </button>
              ))}
              {/* Custom Button */}
              <button onClick={() => setHGCustom(true)} className={`${btn} ${hgCustom ? 'border-accent/40 bg-accent/15 text-accent' : ''}`}>
                ✦ Custom
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* LP Position */}
              <div className={card}>
                <h3 className="text-sm font-semibold mb-4">LP Position</h3>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div>
                    <label className={lbl}>Base Token</label>
                    <input type="text" value={hg.vs} onChange={e => handleHGCustomToken(e.target.value)} className={inp} />
                    {hgFetchingPrice && <span className="text-xs text-warn mt-1">fetching price...</span>}
                  </div>
                  <div><label className={lbl}>Quote Token</label><input type="text" value={hg.ss} onChange={e => setHG(prev => ({ ...prev, ss: e.target.value.toUpperCase() }))} className={inp} /></div>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div><label className={lbl}><TokenIcon symbol={hg.vs} size={14} />{hg.vs} Price</label><input type="number" value={hg.pr} onChange={e => setHG(prev => ({ ...prev, pr: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                  <div><label className={lbl}>Position Value</label><input type="number" value={hg.dep} onChange={e => setHG(prev => ({ ...prev, dep: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs mb-3">
                  <span className="text-warn order-1">${fmtHG(hgC.lp)}</span>
                  <span className="text-pos order-2 sm:order-3">${fmtHG(hgC.up)}</span>
                  <span className="text-fg-muted order-3 sm:order-2 w-full sm:w-auto text-center">${fmtHG(hg.pr)}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div><label className={lbl}>Lower %</label><input type="number" step="0.1" value={hg.lb} onChange={e => setHG(prev => ({ ...prev, lb: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                  <div><label className={lbl}>Upper %</label><input type="number" step="0.1" value={hg.ub} onChange={e => setHG(prev => ({ ...prev, ub: parseFloat(e.target.value) || 0 }))} className={inp} /></div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[5, 10, 20, 50].map(r => <button key={r} onClick={() => setHG(prev => ({ ...prev, lb: -r, ub: r }))} className={btn}>±{r}%</button>)}
                </div>
              </div>

              {/* Hedge Position */}
              <div className={card}>
                <h3 className="text-sm font-semibold mb-4">Hedge Position</h3>
                <div className="bg-surface-2 rounded-xl p-4 mb-4 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--neg)] to-[var(--warn)] flex items-center justify-center text-lg">📉</div>
                    <div>
                      <div className="text-neg font-semibold">Short {hg.vs}</div>
                      <div className="text-fg-muted text-sm font-mono">{fmt(hgC.hSz, 4)} {hg.vs}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold font-mono">${fmtHG(hgC.hVal)}</div>
                    <div className="text-fg-subtle text-xs">Notional</div>
                  </div>
                </div>
                <div className="mb-4">
                  <label className={lbl}>Leverage</label>
                  <div className="grid grid-cols-5 gap-2">
                    {[1, 2, 3, 5, 10].map(lv => (
                      <button key={lv} onClick={() => setHG(prev => ({ ...prev, lev: lv }))} className={`py-3 rounded-xl border text-sm font-semibold transition-all ${hg.lev === lv ? 'bg-accent/20 border-accent/50 text-fg' : 'border-line bg-surface text-fg-muted hover:bg-surface-hover'}`}>{lv}x</button>
                    ))}
                  </div>
                </div>
                <div className="bg-info/10 border border-info/20 rounded-xl p-4 mb-3 flex justify-between items-center">
                  <span className="text-info font-medium">Margin Required</span>
                  <span className="text-lg font-bold font-mono">${fmtHG(hgLD.mR)}</span>
                </div>
                <div className="bg-neg/10 border border-neg/20 rounded-xl p-4 mb-3">
                  <div className="text-neg font-semibold mb-2">⚠️ Liquidation Price</div>
                  <span className="text-2xl font-bold font-mono">${fmtHG(hgLD.liqP)}</span>
                  <span className="text-neg ml-2 font-semibold">(+{fmt(hgLD.liqPct, 1)}%)</span>
                </div>
                <div className="bg-warn/10 border border-warn/20 rounded-xl p-4">
                  <div className="text-warn font-semibold mb-2">🛑 Stop Loss</div>
                  <span className="text-2xl font-bold font-mono">${fmtHG(hgLD.slP)}</span>
                  <span className="text-warn ml-2 font-semibold">(+{fmt(hgLD.slPct, 1)}%)</span>
                  <div className="flex justify-between text-xs mt-2">
                    <span className="text-fg-muted">Loss at stop</span>
                    <span className="text-neg font-semibold">-${fmtHG(hgLD.maxLoss)} (2% of capital)</span>
                  </div>
                  <div className="flex justify-between text-xs mt-1">
                    <span className="text-fg-muted">Buffer to liq</span>
                    <span className="text-pos font-semibold">+{fmt(hgLD.buf, 1)}%</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Position Breakdown */}
            <div className="bg-warn/10 border border-warn/30 rounded-2xl p-5 mb-4">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">📊 Your Position Breakdown</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-2"><TokenIcon symbol={hg.vs} size={24} /><span className="text-fg-muted text-sm">{hg.vs}</span></div>
                  <div className="text-warn text-xl font-bold font-mono">{fmtT(hgC.cE)}</div>
                  <div className="text-fg-subtle text-xs font-mono">${fmtHG(hgC.cEV)}</div>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-2"><TokenIcon symbol={hg.ss} size={24} /><span className="text-fg-muted text-sm">{hg.ss}</span></div>
                  <div className="text-xl font-bold font-mono">{fmtT(hgC.cU)}</div>
                  <div className="text-fg-subtle text-xs font-mono">${fmtHG(hgC.cU)}</div>
                </div>
              </div>
              {[
                { l: `Current ${hg.vs} Value`, v: `$${fmtHG(hgC.cEV)}` },
                { l: 'Optimal Hedge Size', v: `$${fmtHG(hgC.hVal)}` },
                { l: 'Total Capital Required', v: `$${fmtHG(hgLD.tC)}`, c: 'text-pos' },
                { l: 'Capital Efficiency', v: `${fmt(hgLD.capEff, 1)}%` },
              ].map(r => (
                <div key={r.l} className="flex justify-between items-center py-3 border-b border-line last:border-0">
                  <span className="text-fg-muted text-sm">{r.l}</span>
                  <span className={`font-mono font-semibold ${r.c || ''}`}>{r.v}</span>
                </div>
              ))}
              <div className="bg-warn/10 border border-warn/20 rounded-xl p-4 mt-4 text-xs text-fg leading-relaxed">
                💡 <strong>How it works:</strong> Your LP holds <span className="text-warn">{fmtT(hgC.cE)} {hg.vs}</span> worth <span className="text-pos">${fmtHG(hgC.cEV)}</span>. Open a <span className="text-neg">{fmt(hgC.hSz, 4)} {hg.vs} short</span> (${fmtHG(hgC.hVal)} notional). At <span className="text-warn">{hg.lev}x leverage</span>, requires <span className="text-pos">${fmtHG(hgLD.mR)}</span> margin. When {hg.vs} drops to lower range (${fmtHG(hgC.lp)}), short profit offsets LP losses for ~<span className="text-pos">$0 net P&L</span>.
              </div>
            </div>

            {/* Capital & Yield */}
            <div className={card}>
              <h3 className="text-sm font-semibold mb-4">Capital & Yield</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className={lbl}>Funding Rate APR (%)</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input type="number" value={hg.fr} onChange={e => setHG(prev => ({ ...prev, fr: parseFloat(e.target.value) || 0 }))} className={`${inp} w-[72px] shrink-0`} />
                    {[-10, 0, 10, 20, 50].map(f => <button key={f} onClick={() => setHG(prev => ({ ...prev, fr: f }))} className={btn}>{f > 0 ? '+' : ''}{f}%</button>)}
                  </div>
                </div>
                <div>
                  <label className={lbl}>LP Yield APR (%)</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input type="number" value={hg.ly} onChange={e => setHG(prev => ({ ...prev, ly: parseFloat(e.target.value) || 0 }))} className={`${inp} w-[72px] shrink-0`} />
                    {[5, 10, 20, 50, 100, 120].map(y => <button key={y} onClick={() => setHG(prev => ({ ...prev, ly: y }))} className={btn}>{y}%</button>)}
                  </div>
                </div>
              </div>
              {(() => {
                const dLP = (hg.dep * hg.ly / 100) / 365;
                const dFC = (hgC.hVal * hg.fr / 100) / 365;
                const netD = dLP - dFC;
                const netY = netD * 365;
                const netAPR = netY / hgLD.tC * 100;
                return (
                  <div>
                    <div className="bg-surface-2 rounded-xl p-4 mb-4">
                      {[
                        { l: 'LP Position', v: `$${fmtHG(hg.dep)}`, c: 'text-info' },
                        { l: 'Hedge Margin', v: `$${fmtHG(hgLD.mR)}`, c: 'text-warn' },
                        { l: 'Total Capital', v: `$${fmtHG(hgLD.tC)}`, c: 'text-pos', big: true },
                        { l: 'Capital Efficiency', v: `${fmt(hgLD.capEff, 1)}%`, c: 'text-fg' },
                      ].map(r => (
                        <div key={r.l} className="flex justify-between items-center py-2.5 border-b border-line last:border-0">
                          <span className="text-fg-muted text-sm">{r.l}</span>
                          <span className={`font-mono font-semibold ${r.big ? 'text-base' : ''} ${r.c}`}>{r.v}</span>
                        </div>
                      ))}
                    </div>
                    <div className="bg-surface-2 rounded-xl p-4 mb-4">
                      {[
                        { l: 'LP Yield (daily)', v: `+$${fmtHG(dLP)}`, c: 'text-pos' },
                        { l: 'Funding Cost (daily)', v: `${hg.fr > 0 ? '-' : '+'}$${fmtHG(Math.abs(dFC))}`, c: hg.fr > 0 ? 'text-neg' : 'text-pos' },
                        { l: 'Net Daily Yield', v: `${netD >= 0 ? '+' : ''}$${fmtHG(netD)}`, c: netD >= 0 ? 'text-pos' : 'text-neg', big: true },
                        { l: 'Net APR on Total Capital', v: `${netAPR >= 0 ? '+' : ''}${fmt(netAPR, 1)}%`, c: netAPR >= 0 ? 'text-pos' : 'text-neg', big: true },
                      ].map(r => (
                        <div key={r.l} className="flex justify-between items-center py-2.5 border-b border-line last:border-0">
                          <span className="text-fg-muted text-sm">{r.l}</span>
                          <span className={`font-mono font-semibold ${r.big ? 'text-base' : ''} ${r.c}`}>{r.v}</span>
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="bg-pos/10 border border-pos/20 rounded-xl p-5 text-center">
                        <div className="text-fg-muted text-xs uppercase tracking-wider mb-2">Monthly Yield</div>
                        <div className={`text-2xl font-bold font-mono ${netY / 12 >= 0 ? 'text-pos' : 'text-neg'}`}>{netY / 12 >= 0 ? '+' : ''}${fmtHG(netY / 12)}</div>
                      </div>
                      <div className="bg-info/10 border border-info/20 rounded-xl p-5 text-center">
                        <div className="text-fg-muted text-xs uppercase tracking-wider mb-2">Yearly Yield</div>
                        <div className={`text-2xl font-bold font-mono ${netY >= 0 ? 'text-pos' : 'text-neg'}`}>{netY >= 0 ? '+' : ''}${fmtHG(netY)}</div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Scenarios */}
            <div className={card}>
              <h3 className="text-sm font-semibold mb-4">Outcome Scenarios</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-line">
                      {['Scenario', 'Price', 'LP P&L', 'Hedge P&L', 'Net P&L', 'Net %'].map(h => (
                        <th key={h} className="py-3 px-2 text-left text-fg-muted text-xs uppercase font-semibold last:text-right">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { l: `${hg.vs} -30%`, pc: -30 }, { l: `${hg.vs} -15%`, pc: -15 },
                      { l: `Lower (${fmt(hg.lb, 1)}%)`, pc: hg.lb, w: true }, { l: 'No Change', pc: 0 },
                      { l: `Stop (+${fmt(hgLD.slPct, 1)}%)`, pc: hgLD.slPct, d: true },
                      { l: `Upper (+${fmt(hg.ub, 1)}%)`, pc: hg.ub, w: true },
                      { l: `${hg.vs} +15%`, pc: 15 }, { l: `${hg.vs} +30%`, pc: 30 },
                    ].map(sc => {
                      const o = hgC.calcOut(hg.pr * (1 + sc.pc / 100));
                      return (
                        <tr key={sc.l} className={`border-b border-line ${(sc as any).w ? 'bg-warn/10' : (sc as any).d ? 'bg-neg/10' : ''}`}>
                          <td className="py-3 px-2 font-medium" style={{ color: (sc as any).w ? 'var(--warn)' : (sc as any).d ? 'var(--neg)' : 'var(--fg)' }}>{sc.l}</td>
                          <td className="py-3 px-2 font-mono">${fmtHG(o.pr)}</td>
                          <td className={`py-3 px-2 font-mono ${o.lpPnl >= 0 ? 'text-pos' : 'text-neg'}`}>{o.lpPnl >= 0 ? '+' : ''}${fmtHG(o.lpPnl)}</td>
                          <td className={`py-3 px-2 font-mono ${o.hPnl >= 0 ? 'text-pos' : 'text-neg'}`}>{o.hPnl >= 0 ? '+' : ''}${fmtHG(o.hPnl)}</td>
                          <td className={`py-3 px-2 font-mono font-semibold ${o.net >= 0 ? 'text-pos' : 'text-neg'}`}>{o.net >= 0 ? '+' : ''}${fmtHG(o.net)}</td>
                          <td className={`py-3 px-2 font-mono text-right ${o.netPct >= 0 ? 'text-pos' : 'text-neg'}`}>{o.netPct >= 0 ? '+' : ''}{fmt(o.netPct, 1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <div className="text-center mt-10 text-fg-subtle text-xs">Built for DeFi · Concentrated Liquidity Analytics</div>
      </div>
    </div>
  );
}