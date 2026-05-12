"use client";

import { useState, useEffect } from "react";

export default function AnimatedCount({
  target,
  prefix = "",
  suffix = "",
  decimals = 2,
  durationMs = 1300,
}: {
  target: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  durationMs?: number;
}) {
  const [val, setVal] = useState(target * 0.75);
  useEffect(() => {
    let start: number | null = null;
    let raf = 0;
    const from = target * 0.75;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / durationMs, 1);
      const ease = 1 - Math.pow(1 - p, 4);
      setVal(from + (target - from) * ease);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return (
    <>
      {prefix}
      {val.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </>
  );
}
