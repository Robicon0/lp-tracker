"use client";

const PROTOCOL_COUNT = 7;
const CHAIN_COUNT = 3;

const TICKERS: { sym: string; price: string; chg: string; up: boolean }[] = [
  { sym: "ETH", price: "3,182.40", chg: "+2.14%", up: true },
  { sym: "SOL", price: "182.50", chg: "+4.71%", up: true },
  { sym: "BTC", price: "94,210.00", chg: "+1.08%", up: true },
  { sym: "SUI", price: "3.84", chg: "-1.22%", up: false },
  { sym: "AAVE", price: "228.10", chg: "+3.40%", up: true },
  { sym: "UNI", price: "11.42", chg: "+0.88%", up: true },
  { sym: "ARB", price: "1.18", chg: "-0.54%", up: false },
];

export default function PriceTickerStrip() {
  const doubled = [...TICKERS, ...TICKERS];
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@keyframes defidesh-ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }",
        }}
      />
      <div className="border-b border-[#1f1f1f] px-4 sm:px-12 flex items-stretch h-12 overflow-hidden">
        <div className="flex items-center gap-2.5 pr-6 sm:pr-8 border-r border-[#1f1f1f] whitespace-nowrap">
          <span className="text-[#00ff41] font-bold text-[13px] tabular-nums">
            {PROTOCOL_COUNT}
          </span>
          <span className="text-[#888] uppercase tracking-[0.12em] text-[11px]">Protocols</span>
        </div>
        <div className="flex items-center gap-2.5 px-6 sm:px-8 border-r border-[#1f1f1f] whitespace-nowrap">
          <span className="text-[#00ff41] font-bold text-[13px] tabular-nums">
            {CHAIN_COUNT}
          </span>
          <span className="text-[#888] uppercase tracking-[0.12em] text-[11px]">Chains</span>
        </div>
        <div className="flex items-center gap-2 px-8 border-r border-[#1f1f1f] whitespace-nowrap">
          <span className="inline-block w-[5px] h-[5px] bg-[#00ff41] animate-pulse" />
          <span className="text-[#00e5ff] uppercase tracking-[0.12em] text-[11px]">
            LIVE Prices
          </span>
        </div>
        <div className="flex-1 overflow-hidden flex items-center">
          <div
            className="flex gap-10 whitespace-nowrap pl-8"
            style={{ animation: "defidesh-ticker 25s linear infinite" }}
          >
            {doubled.map((t, i) => (
              <div key={i} className="text-[11px] flex gap-2 items-center">
                <span className="text-[#888]">{t.sym}</span>
                <span className="text-[#e8e8e8] tabular-nums">${t.price}</span>
                <span
                  className={`tabular-nums ${t.up ? "text-[#00ff41]" : "text-[#ff3366]"}`}
                >
                  {t.chg}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
