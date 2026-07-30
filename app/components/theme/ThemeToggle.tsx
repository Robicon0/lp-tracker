"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_STORAGE_KEY } from "./ThemeScript";

type Choice = "light" | "dark" | "system";

const OPTIONS: { value: Choice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
];

let switchTimer: ReturnType<typeof setTimeout> | undefined;

function apply(choice: Choice) {
  // Paint the colour transition only for the duration of the swap — see the
  // .theme-switching rule in globals.css for why this is not permanent.
  const root = document.documentElement;
  root.classList.add("theme-switching");
  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => root.classList.remove("theme-switching"), 240);

  const resolved =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : choice;
  root.setAttribute("data-theme", resolved);
  root.style.colorScheme = resolved;
  if (choice === "system") localStorage.removeItem(THEME_STORAGE_KEY);
  else localStorage.setItem(THEME_STORAGE_KEY, choice);
}

/**
 * Three-state theme control: Light / System / Dark.
 *
 * Three states, not a two-state switch, because a binary toggle silently
 * destroys the "follow my OS" behaviour the moment it is touched once — the
 * user can never get back to automatic. System is the middle position and is
 * represented by the ABSENCE of a stored key, so it stays honest across
 * devices.
 *
 * Rendered as a segmented control rather than a dropdown: current state is
 * visible without interaction, and each target is a direct 1-click hit.
 */
export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [choice, setChoice] = useState<Choice>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    setChoice(stored === "light" || stored === "dark" ? stored : "system");
    setMounted(true);
  }, []);

  // Keep following the OS while the user is on "system".
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  function select(next: Choice) {
    setChoice(next);
    apply(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex items-center gap-px rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] p-px"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        // Before mount the stored value is unknown; render all three inactive
        // rather than guessing, so we never flash a wrong active pip.
        const active = mounted && choice === value;
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => select(value)}
            className="cursor-pointer rounded-[var(--r-sm)] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{
              display: "grid",
              placeItems: "center",
              width: compact ? 26 : 30,
              height: compact ? 26 : 30,
              background: active ? "var(--surface-hover)" : "transparent",
              color: active ? "var(--accent)" : "var(--fg-subtle)",
            }}
          >
            <Icon size={compact ? 13 : 14} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );
}
