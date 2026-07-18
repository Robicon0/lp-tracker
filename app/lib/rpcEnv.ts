// Shared guard for URL-typed RPC env vars.
//
// A malformed value (e.g. a bare API key pasted where a full URL belongs) must
// behave exactly like an UNSET var, so every existing "env unset → degrade
// gracefully" path also covers "env malformed" — never a hard 500 that
// silently drops a feature's contribution from Capital G/L / Fee Income totals.
//
// Live incident (2026-07-18): ALCHEMY_SOLANA_RPC was set in Vercel to the bare
// Alchemy API key instead of the full https URL. fetch() threw
// "TypeError: Failed to parse URL from <key>", /api/solana-closed-positions
// returned 500 on every load, and Solana closed-position Capital G/L silently
// vanished from production totals. The unset-var path already degraded
// gracefully; the malformed-var path did not — this helper closes that gap for
// every URL-typed RPC env var, current and future.
//
// Usage: const RPC = rpcUrlFromEnv('SOME_RPC_URL');  // '' when unset OR malformed
// Key-typed vars (e.g. HELIUS_API_KEY) that are interpolated into a hardcoded
// URL don't need this guard — they can't produce a URL parse throw.

const warnedVars = new Set<string>();

export function rpcUrlFromEnv(name: string): string {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('non-http protocol');
    return raw;
  } catch {
    // Never log the raw value — it is likely a secret (bare API key).
    if (!warnedVars.has(name)) {
      warnedVars.add(name);
      const shape = raw.startsWith('http') ? 'a malformed URL' : 'a bare API key or URL fragment';
      console.error(
        `[rpcEnv] ${name} is set but is not a valid http(s) URL (looks like ${shape}, ${raw.length} chars). ` +
          `Treating it as UNSET so the dependent feature degrades gracefully instead of erroring. ` +
          `Fix the value in the environment settings (it must be a full https:// endpoint URL).`,
      );
    }
    return '';
  }
}
