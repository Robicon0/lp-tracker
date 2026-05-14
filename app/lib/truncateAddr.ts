/**
 * Uniform wallet-address truncation used everywhere in the UI.
 *
 * `0xD99a5c1d3F93F1a7cfA77025A8F1532a0cEF4F20` → `0xD9…4F20`
 *
 * EVM, Solana base58, and Sui all share the same format so any new chain added
 * in the future automatically renders consistently. The ellipsis is the single
 * `…` glyph (U+2026), not three dots, matching the existing Solana chip style.
 *
 * Strings shorter than `head + tail + 2` are returned unchanged so the
 * truncation never produces something longer than the input.
 */
export function truncateAddr(addr: string | null | undefined, head = 4, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
