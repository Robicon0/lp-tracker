"use client";

import { useState, useEffect } from "react";

export default function BlinkingCursor() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn((v) => !v), 530);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      style={{ color: "var(--accent)", opacity: on ? 1 : 0, marginLeft: 4, transition: "opacity 0.05s" }}
    >
      ▊
    </span>
  );
}
