import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { useWatchedWallets } from "../contexts/WatchedWalletsContext";
import { getTokenLogo } from "../lib/tokenLogos";

const CHAINS: Array<{ name: string; url: string; nativeSymbol: string; nativeName: string }> = [
  { name: "Ethereum", url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`, nativeSymbol: "ETH",   nativeName: "Ethereum" },
  { name: "Base",     url: `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`, nativeSymbol: "ETH",   nativeName: "Ethereum" },
  { name: "Arbitrum", url: `https://arb-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`, nativeSymbol: "ETH",   nativeName: "Ethereum" },
  { name: "Optimism", url: `https://opt-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`, nativeSymbol: "ETH",   nativeName: "Ethereum" },
  { name: "Polygon",  url: `https://polygon-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`, nativeSymbol: "MATIC", nativeName: "Polygon"  },
];

// HyperEVM has no Alchemy support, so we cannot use alchemy_getTokenBalances.
// Instead we batch-call balanceOf() against a curated list of common HyperEVM
// tokens via the public RPC. Adding a new HyperEVM token = append one row
// below; everything else (pricing via SYMBOL_TO_CG_ID, grouping under the EVM
// section on the wallet-balances page, donut breakdown) lights up automatically.
const HYPER_EVM_RPC = "https://rpc.hyperliquid.xyz/evm";
const HYPER_EVM_TOKENS: Array<{ symbol: string; addr: string; decimals: number }> = [
  { symbol: "wstHYPE", addr: "0x94e8396e0869c9f2200760af0621afd240e1cf38", decimals: 18 },
  { symbol: "USDXL",   addr: "0xca79db4b49f608ef54a5cb813fbed3a6387bc645", decimals: 18 },
  { symbol: "UBTC",    addr: "0x9fdbda0a5e284c32744d2f17ee5c74b284993463", decimals: 8  },
  { symbol: "UETH",    addr: "0xbe6727b535545c67d5caa73dea54865b92cf7907", decimals: 18 },
  { symbol: "USDe",    addr: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", decimals: 18 },
  { symbol: "feUSD",   addr: "0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70", decimals: 18 },
  { symbol: "USDT0",   addr: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", decimals: 6  },
  { symbol: "USDHL",   addr: "0xb50a96253abdf803d85efcdce07ad8becbc52bd5", decimals: 6  },
  { symbol: "USOL",    addr: "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", decimals: 9  },
  { symbol: "kHYPE",   addr: "0xfd739d4e423301ce9385c1fb8850539d657c296d", decimals: 18 },
  { symbol: "XAUt0",   addr: "0xf4d9235269a96aadafc9adae454a0618ebe37949", decimals: 6  },
  { symbol: "thBILL",  addr: "0xfdd22ce6d1f66bc0ec89b20bf16ccb6670f55a5a", decimals: 6  },
  { symbol: "sUSDe",   addr: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", decimals: 18 },
  { symbol: "beHYPE",  addr: "0xd8fc8f0b03eba61f64d08b0bef69d80916e5dda9", decimals: 18 },
  { symbol: "USDC",    addr: "0xb88339cb7199b77e23db6e890353e22632ba630f", decimals: 6  },
  { symbol: "USDH",    addr: "0x111111a1a0667d36bd57c0a9f569b98057111111", decimals: 6  },
];
const SEL_BALANCE_OF = "0x70a08231";

const ZERO_HEX = "0x" + "0".repeat(64);
const STABLE_SYMBOLS = new Set([
  "USDC", "USDT", "DAI", "USDBC", "USDC.E", "USDS", "FRAX", "LUSD", "BUSD", "GUSD",
  "PYUSD", "CRVUSD", "GHO", "FDUSD", "TUSD", "USDP", "SUSD", "USDD", "USD0", "USDE",
  "USDT0", "USDHL", "USDA", "USDN", "FEI", "SDAI", "SUSDS", "DOLA", "MIM",
  // HyperEVM-specific stables
  "USDXL", "FEUSD", "USDH",
]);

// Broad symbol → CoinGecko ID map used to look up USD prices for any
// supplied / borrowed asset the user holds across AAVE V3, HyperLend, etc.
// Adding a symbol here immediately enriches it everywhere (Wallet Balances,
// Lending page, Analytics) — no per-protocol code change required.
const SYMBOL_TO_CG_ID: Record<string, string> = {
  // Majors
  ETH: "ethereum", WETH: "ethereum",
  BTC: "bitcoin", WBTC: "bitcoin", CBBTC: "bitcoin", TBTC: "bitcoin", UBTC: "bitcoin",
  SOL: "solana", WSOL: "solana", USOL: "solana",
  SUI: "sui",
  HYPE: "hyperliquid", WHYPE: "hyperliquid", KHYPE: "hyperliquid", BEHYPE: "hyperliquid",
  MATIC: "matic-network", POL: "matic-network",
  ARB: "arbitrum", OP: "optimism",
  BNB: "binancecoin", WBNB: "binancecoin",
  AVAX: "avalanche-2", WAVAX: "avalanche-2",
  // LSTs / LRTs
  STETH: "staked-ether", WSTETH: "wrapped-steth",
  CBETH: "coinbase-wrapped-staked-eth", RETH: "rocket-pool-eth",
  WEETH: "wrapped-eeth", EZETH: "renzo-restaked-eth", RSETH: "kelp-dao-restaked-eth",
  OSETH: "stakewise-v3-oseth", ETHX: "stader-ethx", METH: "mantle-staked-ether",
  UETH: "ethereum", WSTHYPE: "hyperliquid",
  SUSDE: "ethena-staked-usde",
  // DeFi blue chips
  AAVE: "aave", LINK: "chainlink", UNI: "uniswap", CRV: "curve-dao-token",
  MKR: "maker", LDO: "lido-dao", COMP: "compound-governance-token",
  SNX: "havven", BAL: "balancer", RPL: "rocket-pool", FXS: "frax-share",
  CVX: "convex-finance", "1INCH": "1inch", SUSHI: "sushi", GMX: "gmx",
  // Memes & alts
  PEPE: "pepe", SHIB: "shiba-inu", DOGE: "dogecoin", WIF: "dogwifcoin",
  // Additional majors surfaced by PriceTickerStrip — listed here so any
  // wallet-token surfaces that happen to hold these symbols can price them.
  // (WBTC/CBBTC stay aliased to 'bitcoin' above for wallet-balance aggregation
  // — see CLAUDE.md. The ticker uses its own TICKER_CG_IDS table for per-
  // wrapper prices.)
  AERO: "aerodrome-finance",
  TAO: "bittensor",
  ZCASH: "zcash", ZEC: "zcash",
  // HyperEVM-specific (most map via existing aliases above — listed here for
  // explicitness)
  XAUT0: "tether-gold",
};

// CoinGecko platform IDs for contract-address price lookups per chain.
const CG_PLATFORM: Record<string, string> = {
  Ethereum: "ethereum",
  Base: "base",
  Arbitrum: "arbitrum-one",
  Optimism: "optimistic-ethereum",
  Polygon: "polygon-pos",
};

// AAVE V3 wraps every reserve as a prefixed token:
//   aToken:         aBasUSDC, aArbUSDT, aPolUSDCn, aEthWETH, ...
//   debt tokens:    variableDebtArbUSDT, stableDebtOptDAI, ...
// These prefixes are an internal AAVE convention. The user wants to see the
// UNDERLYING asset name (USDC, USDT, DAI, WETH) on every display surface.
//
// `stripAavePrefix(raw)` returns the on-chain underlying symbol by stripping:
//   1. AAVE token-class prefix:  variableDebt | stableDebt | a
//   2. AAVE chain sub-prefix:    Bas | Arb | Opt | Eth | Pol
//   3. trailing "n" on native-USDC markets (aArbUSDCn → USDC)
// If the input doesn't match the AAVE naming shape, the symbol is returned
// unchanged — so non-AAVE tokens (USDC from a pool, WHYPE from a wallet, etc.)
// are pass-through.
const AAVE_CHAIN_PREFIXES = ["Bas", "Arb", "Opt", "Eth", "Pol"];

function stripAavePrefix(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  if (/^variableDebt/.test(s))      s = s.slice("variableDebt".length);
  else if (/^stableDebt/.test(s))   s = s.slice("stableDebt".length);
  else if (/^a[A-Z]/.test(s))       s = s.slice(1);
  else return raw; // not an AAVE wrapper — leave symbol as-is
  for (const p of AAVE_CHAIN_PREFIXES) {
    if (s.startsWith(p) && /^[A-Z0-9]/.test(s.slice(p.length))) {
      s = s.slice(p.length);
      break;
    }
  }
  if (s.endsWith("n") && s.length > 1 && /[A-Z]$/.test(s.slice(-2, -1))) {
    s = s.slice(0, -1);
  }
  return s || raw;
}

// Detection runs on the RAW symbol (pre-strip), since detection keys off the
// AAVE wrapper prefix which strip removes.
function isLendingToken(rawSymbol: string): boolean {
  return /^a[A-Z]/.test(rawSymbol);
}

function isDebtToken(rawSymbol: string): boolean {
  return /^variableDebt/.test(rawSymbol) || /^stableDebt/.test(rawSymbol);
}

export interface TokenItem {
  symbol: string;
  name: string;
  balance: number;
  usdValue: number;
  price: number;
  /** 24h price change percentage (signed). null when unknown. */
  change24h: number | null;
  chain: string;
  logo: string;
  isLending: boolean;
  isDebt: boolean;
  contractAddress: string;
}

export interface WalletTokensData {
  tokens: TokenItem[];
  totalTokenValue: number;
  totalLendingValue: number;
  totalDebtValue: number;
  tokenCount: number;
  lendingCount: number;
  isLoading: boolean;
}

export function useWalletTokens(): WalletTokensData {
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets } = useWatchedWallets();

  // Combine connected + watched wallets per chain (dedup, lowercase for EVM).
  const evmAddresses = Array.from(new Set(
    [address, ...watchedWallets.filter((w) => w.chain === "evm").map((w) => w.address)]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase())
  ));
  const solanaAddresses = Array.from(new Set(
    [solanaAddress, ...watchedWallets.filter((w) => w.chain === "solana").map((w) => w.address)]
      .filter((a): a is string => !!a)
  ));
  const suiAddresses = Array.from(new Set(
    [suiAddress, ...watchedWallets.filter((w) => w.chain === "sui").map((w) => w.address)]
      .filter((a): a is string => !!a)
  ));

  const fetchedForRef = useRef<string | null>(null);

  const [data, setData] = useState<WalletTokensData>({
    tokens: [],
    totalTokenValue: 0,
    totalLendingValue: 0,
    totalDebtValue: 0,
    tokenCount: 0,
    lendingCount: 0,
    isLoading: false,
  });

  const evmKey = evmAddresses.join(",");
  const solKey = solanaAddresses.join(",");
  const suiKey = suiAddresses.join(",");

  useEffect(() => {
    // Composite key — refetch whenever any wallet (connected or watched) changes
    const fetchKey = [evmKey, solKey, suiKey].filter(Boolean).join("|") || null;

    if (!fetchKey || fetchedForRef.current === fetchKey) return;

    console.log("[useWalletTokens] Starting fetch for wallets:", { evm: evmAddresses, solana: solanaAddresses, sui: suiAddresses });
    fetchedForRef.current = fetchKey;
    let cancelled = false;
    let fetchCompleted = false;
    setData((prev) => ({ ...prev, isLoading: true }));

    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        console.error("[useWalletTokens] timed out after 30s — showing partial data");
        cancelled = true;
        setData((prev) => ({ ...prev, isLoading: false }));
      }
    }, 30_000);

    (async () => {
      try {
        // Fetch prices for every token we know a CoinGecko ID for, in one call.
        // Covers majors, LSTs/LRTs, DeFi blue chips, and a handful of memes — so
        // AAVE reserves like wstETH, LINK, AAVE, LDO all render with correct USD.
        const priceById: Record<string, number> = {};
        const changeById: Record<string, number> = {};
        try {
          const uniqueIds = Array.from(new Set(Object.values(SYMBOL_TO_CG_ID)));
          const res = await fetch(
            `/api/prices?endpoint=simple/price&ids=${uniqueIds.join(",")}&vs_currencies=usd&include_24hr_change=true`,
          ).then((r) => r.json());
          for (const id of uniqueIds) {
            priceById[id]  = res?.[id]?.usd ?? 0;
            changeById[id] = res?.[id]?.usd_24h_change ?? 0;
          }
        } catch (err) { console.error("[useWalletTokens] price fetch failed:", err); }

        function cgIdFor(symbol: string): string | null {
          return SYMBOL_TO_CG_ID[symbol.toUpperCase()] ?? null;
        }

        function changeOf(symbol: string): number | null {
          const s = symbol.toUpperCase();
          if (STABLE_SYMBOLS.has(s)) return 0;
          const id = cgIdFor(s);
          if (!id) return null;
          const v = changeById[id];
          return typeof v === "number" ? v : null;
        }

        function priceOf(symbol: string): number {
          const s = symbol.toUpperCase();
          if (STABLE_SYMBOLS.has(s)) return 1;
          const id = cgIdFor(s);
          if (!id) return 0;
          return priceById[id] ?? 0;
        }

        const tokens: TokenItem[] = [];

        // Build parallel scan tasks for each connected wallet
        const scanTasks: Promise<void>[] = [];

        // ── EVM chains via Alchemy ────────────────────────────────────────────
        if (evmAddresses.length > 0 && process.env.NEXT_PUBLIC_ALCHEMY_KEY) {
          for (const evmAddr of evmAddresses) {
          scanTasks.push(
            ...CHAINS.map(async (chain) => {
              const post = (body: object) =>
                fetch(chain.url, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                }).then((r) => r.json());

              try {
                console.log(`[useWalletTokens] Scanning ${chain.name} for ${evmAddr}...`);

                // Native chain coin (ETH on Eth/Base/Arb/Op, MATIC on Polygon).
                // alchemy_getTokenBalances ONLY returns ERC-20s — native
                // balance has to be fetched separately or it never appears.
                try {
                  const natRes = await post({
                    jsonrpc: "2.0", id: 0,
                    method: "eth_getBalance",
                    params: [evmAddr, "latest"],
                  });
                  if (natRes?.result) {
                    const natBal = Number(BigInt(natRes.result)) / 1e18;
                    if (natBal > 0 && !cancelled) {
                      const price = priceOf(chain.nativeSymbol);
                      tokens.push({
                        symbol: chain.nativeSymbol,
                        name: chain.nativeName,
                        balance: natBal,
                        usdValue: natBal * price,
                        price,
                        change24h: changeOf(chain.nativeSymbol),
                        chain: chain.name,
                        logo: getTokenLogo(chain.nativeSymbol) || "",
                        isLending: false,
                        isDebt: false,
                        contractAddress: "native",
                      });
                    }
                  }
                } catch (err) { console.error(`[useWalletTokens] ${chain.name} native balance failed:`, err); }

                const balRes = await post({
                  jsonrpc: "2.0", id: 1,
                  method: "alchemy_getTokenBalances",
                  params: [evmAddr, "erc20"],
                });
                const nonZero = (balRes.result?.tokenBalances ?? []).filter(
                  (t: { tokenBalance: string }) => t.tokenBalance && t.tokenBalance !== ZERO_HEX,
                );
                const top = nonZero.slice(0, 50);

                await Promise.allSettled(
                  top.map(async (token: { contractAddress: string; tokenBalance: string }) => {
                    try {
                      const meta = await post({
                        jsonrpc: "2.0", id: 2,
                        method: "alchemy_getTokenMetadata",
                        params: [token.contractAddress],
                      });
                      const m = meta.result;
                      if (!m?.symbol || m.symbol.length >= 20) return;
                      // Detect lending/debt against the RAW on-chain symbol —
                      // the detection keys on the AAVE wrapper prefix which the
                      // strip step removes.
                      const lending = isLendingToken(m.symbol);
                      const debt = isDebtToken(m.symbol);
                      // Display symbol: for AAVE aTokens / debtTokens, use the
                      // stripped underlying (USDC, USDT, DAI, WETH, …). For
                      // everything else the on-chain symbol passes through
                      // unchanged.
                      const displaySymbol = stripAavePrefix(m.symbol);
                      const decimals = m.decimals || 18;
                      const rawBal = BigInt(token.tokenBalance);
                      const balance = Number(rawBal) / Math.pow(10, decimals);
                      // Filter only true-zero balances at scan time. The page-
                      // level "Hide dust < $0.01" toggle handles USD-value
                      // filtering — keeping the scan permissive ensures every
                      // real holding reaches the page even before pricing.
                      if (balance <= 0) return;
                      const price = priceOf(displaySymbol);
                      const usdValue = balance * price;
                      if (!cancelled) {
                        tokens.push({
                          symbol: displaySymbol,
                          name: displaySymbol,
                          balance,
                          usdValue,
                          price,
                          change24h: changeOf(displaySymbol),
                          chain: chain.name,
                          logo: m.logo || getTokenLogo(displaySymbol) || "",
                          isLending: lending,
                          isDebt: debt,
                          contractAddress: token.contractAddress,
                        });
                      }
                    } catch (err) { console.error(`[useWalletTokens] ${chain.name} token metadata failed for ${token.contractAddress}:`, err); }
                  }),
                );
                console.log(`[useWalletTokens] ${chain.name} done for ${evmAddr}`);
              } catch (err) { console.error(`[useWalletTokens] ${chain.name} chain scan failed:`, err); }
            }),
          );
          }
        } else if (evmAddresses.length > 0) {
          console.warn("[useWalletTokens] NEXT_PUBLIC_ALCHEMY_KEY missing — skipping EVM token scan");
        }

        // ── HyperEVM via public RPC (no Alchemy) ──────────────────────────────
        // One batched JSON-RPC POST per wallet covers native HYPE +
        // balanceOf() against every entry in HYPER_EVM_TOKENS. Append a new
        // entry to that list to surface a new HyperEVM token here.
        for (const evmAddr of evmAddresses) {
          scanTasks.push((async () => {
            try {
              console.log(`[useWalletTokens] Scanning HyperEVM for ${evmAddr}...`);
              const padded = evmAddr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
              const batch: object[] = [
                {
                  jsonrpc: "2.0",
                  id: 0,
                  method: "eth_getBalance",
                  params: [evmAddr, "latest"],
                },
                ...HYPER_EVM_TOKENS.map((t, i) => ({
                  jsonrpc: "2.0",
                  id: i + 1,
                  method: "eth_call",
                  params: [{ to: t.addr, data: SEL_BALANCE_OF + padded }, "latest"],
                })),
              ];
              const resp = await fetch(HYPER_EVM_RPC, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(batch),
              });
              if (!resp.ok || cancelled) return;
              const arr: unknown = await resp.json();
              if (cancelled || !Array.isArray(arr)) return;
              const byId = new Map<number, string | undefined>();
              for (const r of arr as Array<{ id: number; result?: string }>) {
                byId.set(r.id, r.result);
              }

              // Native HYPE
              const nativeHex = byId.get(0);
              if (nativeHex) {
                try {
                  const nativeBal = Number(BigInt(nativeHex)) / 1e18;
                  if (nativeBal > 0) {
                    const price = priceOf("HYPE");
                    tokens.push({
                      symbol: "HYPE",
                      name: "Hyperliquid",
                      balance: nativeBal,
                      usdValue: nativeBal * price,
                      price,
                      change24h: changeOf("HYPE"),
                      chain: "HyperEVM",
                      logo: getTokenLogo("HYPE") || "",
                      isLending: false,
                      isDebt: false,
                      contractAddress: "native",
                    });
                  }
                } catch { /* skip malformed result */ }
              }

              // ERC-20 balances
              for (let i = 0; i < HYPER_EVM_TOKENS.length; i++) {
                const t = HYPER_EVM_TOKENS[i];
                const hex = byId.get(i + 1);
                if (!hex || hex === "0x" || hex === ZERO_HEX) continue;
                let rawBal: bigint;
                try { rawBal = BigInt(hex); } catch { continue; }
                if (rawBal === 0n) continue;
                const balance = Number(rawBal) / Math.pow(10, t.decimals);
                if (balance <= 0) continue;
                const price = priceOf(t.symbol);
                tokens.push({
                  symbol: t.symbol,
                  name: t.symbol,
                  balance,
                  usdValue: balance * price,
                  price,
                  change24h: changeOf(t.symbol),
                  chain: "HyperEVM",
                  logo: getTokenLogo(t.symbol) || "",
                  isLending: false,
                  isDebt: false,
                  contractAddress: t.addr,
                });
              }
              console.log(`[useWalletTokens] HyperEVM done for ${evmAddr}`);
            } catch (err) {
              console.error("[useWalletTokens] HyperEVM scan failed:", err);
            }
          })());
        }

        // ── Solana via /api/solana/balances (Helius server-side) ─────────────
        for (const solAddr of solanaAddresses) {
          scanTasks.push((async () => {
            try {
              console.log(`[useWalletTokens] Scanning Solana for ${solAddr}...`);
              const res = await fetch(`/api/solana/balances?account=${solAddr}`).then((r) => r.json());
              if (cancelled) return;

              // Native SOL
              const solBal = parseFloat(res.solBalance ?? "0");
              if (solBal > 0) {
                tokens.push({
                  symbol: "SOL",
                  name: "Solana",
                  balance: solBal,
                  usdValue: solBal * priceOf("SOL"),
                  price: priceOf("SOL"),
                  change24h: changeOf("SOL"),
                  chain: "Solana",
                  logo: getTokenLogo("SOL") || "",
                  isLending: false,
                  isDebt: false,
                  contractAddress: "native",
                });
              }

              // SPL tokens
              for (const t of (res.tokens ?? [])) {
                if (cancelled) return;
                const balance = parseFloat(t.balance ?? "0");
                if (balance <= 0) continue;
                const price = priceOf(t.symbol);
                tokens.push({
                  symbol: t.symbol,
                  name: t.name,
                  balance,
                  usdValue: balance * price,
                  price,
                  change24h: changeOf(t.symbol),
                  chain: "Solana",
                  logo: getTokenLogo(t.symbol) || "",
                  isLending: false,
                  isDebt: false,
                  contractAddress: t.mint ?? "",
                });
              }
              console.log("[useWalletTokens] Solana done");
            } catch (err) { console.error("[useWalletTokens] Solana scan failed:", err); }
          })());
        }

        // ── Sui via /api/sui/balances ─────────────────────────────────────────
        for (const suiAddr of suiAddresses) {
          scanTasks.push((async () => {
            try {
              console.log(`[useWalletTokens] Scanning Sui for ${suiAddr}...`);
              const res = await fetch(`/api/sui/balances?account=${suiAddr}`).then((r) => r.json());
              if (cancelled) return;

              // Native SUI
              const suiBal = parseFloat(res.suiBalance ?? "0");
              if (suiBal >= 0.0001) {
                tokens.push({
                  symbol: "SUI",
                  name: "Sui",
                  balance: suiBal,
                  usdValue: suiBal * priceOf("SUI"),
                  price: priceOf("SUI"),
                  change24h: changeOf("SUI"),
                  chain: "Sui",
                  logo: getTokenLogo("SUI") || "",
                  isLending: false,
                  isDebt: false,
                  contractAddress: "0x2::sui::SUI",
                });
              }

              // Other Sui coins
              for (const t of (res.tokens ?? [])) {
                if (cancelled) return;
                const balance = parseFloat(t.balance ?? "0");
                if (balance < 0.0001) continue;
                const price = priceOf(t.symbol);
                tokens.push({
                  symbol: t.symbol,
                  name: t.name,
                  balance,
                  usdValue: balance * price,
                  price,
                  change24h: changeOf(t.symbol),
                  chain: "Sui",
                  logo: getTokenLogo(t.symbol) || "",
                  isLending: false,
                  isDebt: false,
                  contractAddress: t.coinType ?? "",
                });
              }
              console.log("[useWalletTokens] Sui done");
            } catch (err) { console.error("[useWalletTokens] Sui scan failed:", err); }
          })());
        }

        await Promise.allSettled(scanTasks);

        if (cancelled) {
          console.log("[useWalletTokens] Cancelled before setData — isLoading will not be cleared by this run");
          return;
        }

        console.log("[useWalletTokens] Fetch complete, found", tokens.length, "tokens");
        const regular  = tokens.filter((t) => !t.isLending && !t.isDebt);
        const lending  = tokens.filter((t) => t.isLending);
        const debt     = tokens.filter((t) => t.isDebt);

        fetchCompleted = true;
        clearTimeout(timeoutId);
        setData({
          tokens,
          totalTokenValue:   regular.reduce((s, t) => s + t.usdValue, 0),
          totalLendingValue: lending.reduce((s, t) => s + t.usdValue, 0),
          totalDebtValue:    debt.reduce((s, t) => s + t.usdValue, 0),
          tokenCount:  regular.length,
          lendingCount: lending.length,
          isLoading: false,
        });
      } catch (err) {
        console.error("[useWalletTokens] unexpected error — clearing loading state:", err);
        clearTimeout(timeoutId);
        if (!cancelled) setData((prev) => ({ ...prev, isLoading: false }));
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      // Only reset fetchedForRef when the fetch didn't complete. This lets
      // StrictMode's immediate cleanup trigger a retry on remount (fetchCompleted=false
      // since the async work was cancelled before finishing). But when a fetch DID
      // complete, we keep fetchedForRef set so that address oscillations caused by
      // Solana/Sui wallet connect events don't trigger unnecessary re-fetches.
      if (!fetchCompleted) {
        fetchedForRef.current = null;
      }
    };
  }, [evmKey, solKey, suiKey]);

  return data;
}
