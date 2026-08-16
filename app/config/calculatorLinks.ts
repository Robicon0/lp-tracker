/**
 * The Calculator nav menu's contents — the single source for every nav
 * surface (Navbar, TerminalNavbar, TerminalNav, MobileNavMenu, HomeV2).
 *
 * Adding a tool to the menu everywhere it appears is one line here:
 *   { label: "LP Calculator", href: "/lp-calculator" },
 */
export type CalculatorLink = { label: string; href: string };

export const CALCULATOR_MENU_LABEL = "Calculator";

export const CALCULATOR_LINKS: CalculatorLink[] = [
  { label: "CLP Tracker", href: "/clp-tracker" },
];
