"use client";

import Link from "next/link";

const TABS: { label: string; href: string; key: "home" | "dashboard" | "analytics" | "about" }[] = [
  { label: "Home", href: "/", key: "home" },
  { label: "Dashboard", href: "/dashboard", key: "dashboard" },
  { label: "Analytics", href: "/analytics", key: "analytics" },
  { label: "About", href: "/about", key: "about" },
];

export default function TerminalNav({
  active,
}: {
  active?: "home" | "dashboard" | "analytics" | "about";
}) {
  return (
    <nav
      className="sticky top-0 z-[300] h-[52px] flex items-stretch border-b border-[#1c1c1c]"
      style={{ background: "rgba(5,5,5,0.97)", fontFamily: "var(--font-jetbrains-mono)" }}
    >
      <Link
        href="/"
        className="px-7 flex items-center border-r border-[#1c1c1c] no-underline"
        style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" }}
      >
        <span className="text-[#00ff41] font-extrabold">DEFI</span>
        <span className="text-[#262626] font-light mx-[2px]">/</span>
        <span className="text-[#e0e0e0] font-extrabold">DESH</span>
      </Link>
      <div className="flex">
        {TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <Link
              key={t.key}
              href={t.href}
              className={`relative flex items-center px-[22px] border-r border-[#1c1c1c] no-underline transition-colors hover:bg-[#0d0d0d] hover:text-[#aaaaaa] ${isActive ? "text-[#e0e0e0]" : "text-[#a0a0a0]"}`}
              style={{
                fontSize: 15,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              {t.label}
              {isActive && (
                <span
                  className="absolute left-0 right-0 h-px bg-[#00ff41]"
                  style={{ bottom: -1, boxShadow: "0 0 8px rgba(0,255,65,0.18)" }}
                />
              )}
            </Link>
          );
        })}
      </div>
      <div className="flex-1" />
      {/* Read-only / non-custodial security badge */}
      <div
        className="flex items-center my-[10px]"
        style={{
          padding: "4px 10px",
          border: "0.5px solid #00ff4133",
          background: "#00ff4108",
          borderRadius: 3,
          fontSize: 9,
          color: "#00ff41",
          letterSpacing: "0.08em",
          whiteSpace: "nowrap",
        }}
      >
        🔒 READ-ONLY · NON-CUSTODIAL
      </div>
      <div
        className="flex items-center gap-2 my-[10px] mx-4 px-[14px] border border-[#00992a]"
        style={{ background: "rgba(0,255,65,0.06)" }}
      >
        <span
          className="inline-block w-1.5 h-1.5 bg-[#00ff41]"
          style={{ animation: "tn-pulse 2s infinite" }}
        />
        <span
          className="text-[#00ff41]"
          style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase" }}
        >
          All systems nominal
        </span>
      </div>
      <style
        dangerouslySetInnerHTML={{
          __html: "@keyframes tn-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }",
        }}
      />
    </nav>
  );
}
