import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { useWatchedWallets } from "../contexts/WatchedWalletsContext";
import { getTokenLogo } from "../lib/tokenLogos";

const CHAINS = [
  { name: "Ethereum", url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}` },
  { name: "Base",     url: `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}` },
  { name: "Arbitrum", url: `https://arb-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}` },
  { name: "Optimism", url: `https://opt-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}` },
  { name: "Polygon",  url: `https://polygon-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}` },
];

const ZERO_HEX = "0x" + "0".repeat(64);
const STABLE_SYMBOLS = new Set([
  "USDC", "USDT", "DAI", "USDbC", "USDC.E", "USDS", "FRAX", "LUSD", "BUSD", "GUSD",
]);

// aToken detection: AAVE V3 uses chain-prefix patterns; AAVE V2 uses direct names
function getATokenUnderlying(symbol: string): string | null {
  if (symbol.length < 3) return null;
  if (!symbol.startsWith("a") && !symbol.startsWith("A")) return null;
  const rest = symbol.slice(1);
  for (const prefix of ["Bas", "Arb", "Opt", "Eth", "Pol"]) {
    if (rest.startsWith(prefix)) return rest.slice(prefix.length);
  }
  if (/^[A-Z]/.test(rest) && rest.length >= 2) return rest;
  return null;
}

function isLendingToken(symbol: string): boolean {
  return getATokenUnderlying(symbol) !== null;
}

function isDebtToken(symbol: string): boolean {
  const s = symbol.toLowerCase();
  return s.startsWith("variabledebt") || s.startsWith("stabledebt");
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
        // Fetch prices for common tokens across all chains (with 24h change)
        const prices: Record<string, number> = {};
        const changes: Record<string, number> = {};
        try {
          const res = await fetch(
            "/api/prices?endpoint=simple/price&ids=ethereum,bitcoin,solana,sui,matic-network,arbitrum,optimism,binancecoin,avalanche-2&vs_currencies=usd&include_24hr_change=true",
          ).then((r) => r.json());
          prices.ethereum   = res?.ethereum?.usd   ?? 0;
          prices.bitcoin    = res?.bitcoin?.usd    ?? 0;
          prices.solana     = res?.solana?.usd     ?? 0;
          prices.sui        = res?.sui?.usd        ?? 0;
          prices.matic      = res?.["matic-network"]?.usd ?? 0;
          prices.arbitrum   = res?.arbitrum?.usd   ?? 0;
          prices.optimism   = res?.optimism?.usd   ?? 0;
          prices.bnb        = res?.binancecoin?.usd ?? 0;
          prices.avax       = res?.["avalanche-2"]?.usd ?? 0;
          changes.ethereum  = res?.ethereum?.usd_24h_change   ?? 0;
          changes.bitcoin   = res?.bitcoin?.usd_24h_change    ?? 0;
          changes.solana    = res?.solana?.usd_24h_change     ?? 0;
          changes.sui       = res?.sui?.usd_24h_change        ?? 0;
          changes.matic     = res?.["matic-network"]?.usd_24h_change ?? 0;
          changes.arbitrum  = res?.arbitrum?.usd_24h_change   ?? 0;
          changes.optimism  = res?.optimism?.usd_24h_change   ?? 0;
          changes.bnb       = res?.binancecoin?.usd_24h_change ?? 0;
          changes.avax      = res?.["avalanche-2"]?.usd_24h_change ?? 0;
        } catch (err) { console.error("[useWalletTokens] price fetch failed:", err); }

        function changeOf(symbol: string): number | null {
          const s = symbol.toUpperCase();
          if (STABLE_SYMBOLS.has(s)) return 0;
          if (s === "ETH" || s === "WETH" || s === "STETH" || s === "WSTETH") return changes.ethereum ?? null;
          if (s === "BTC" || s === "WBTC" || s === "CBBTC" || s === "TBTC") return changes.bitcoin ?? null;
          if (s === "SOL" || s === "WSOL") return changes.solana ?? null;
          if (s === "SUI") return changes.sui ?? null;
          if (s === "MATIC" || s === "POL") return changes.matic ?? null;
          if (s === "ARB") return changes.arbitrum ?? null;
          if (s === "OP") return changes.optimism ?? null;
          if (s === "BNB" || s === "WBNB") return changes.bnb ?? null;
          if (s === "AVAX") return changes.avax ?? null;
          const underlying = getATokenUnderlying(symbol);
          if (underlying) return changeOf(underlying);
          return null;
        }

        function priceOf(symbol: string): number {
          const s = symbol.toUpperCase();
          if (STABLE_SYMBOLS.has(s)) return 1;
          if (s === "ETH" || s === "WETH" || s === "STETH" || s === "WSTETH") return prices.ethereum;
          if (s === "BTC" || s === "WBTC" || s === "CBBTC" || s === "TBTC") return prices.bitcoin;
          if (s === "SOL" || s === "WSOL") return prices.solana;
          if (s === "SUI") return prices.sui;
          if (s === "MATIC" || s === "POL") return prices.matic;
          if (s === "ARB") return prices.arbitrum;
          if (s === "OP") return prices.optimism;
          if (s === "BNB" || s === "WBNB") return prices.bnb;
          if (s === "AVAX") return prices.avax;
          // aToken: resolve underlying price
          const underlying = getATokenUnderlying(symbol);
          if (underlying) return priceOf(underlying);
          return 0;
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
                      const decimals = m.decimals || 18;
                      const rawBal = BigInt(token.tokenBalance);
                      const balance = Number(rawBal) / Math.pow(10, decimals);
                      if (balance < 0.0001) return;
                      const price = priceOf(m.symbol);
                      const usdValue = balance * price;
                      const lending = isLendingToken(m.symbol);
                      const debt = isDebtToken(m.symbol);
                      if (!cancelled) {
                        tokens.push({
                          symbol: m.symbol,
                          name: m.name && m.name.length < 40 ? m.name : m.symbol,
                          balance,
                          usdValue,
                          price,
                          change24h: changeOf(m.symbol),
                          chain: chain.name,
                          logo: m.logo || getTokenLogo(m.symbol) || "",
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

        // ── Solana via /api/solana/balances (Helius server-side) ─────────────
        for (const solAddr of solanaAddresses) {
          scanTasks.push((async () => {
            try {
              console.log(`[useWalletTokens] Scanning Solana for ${solAddr}...`);
              const res = await fetch(`/api/solana/balances?account=${solAddr}`).then((r) => r.json());
              if (cancelled) return;

              // Native SOL
              const solBal = parseFloat(res.solBalance ?? "0");
              if (solBal >= 0.0001) {
                tokens.push({
                  symbol: "SOL",
                  name: "Solana",
                  balance: solBal,
                  usdValue: solBal * (prices.solana ?? 0),
                  price: prices.solana ?? 0,
                  change24h: changes.solana ?? null,
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
                if (balance < 0.0001) continue;
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
                  usdValue: suiBal * (prices.sui ?? 0),
                  price: prices.sui ?? 0,
                  change24h: changes.sui ?? null,
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
