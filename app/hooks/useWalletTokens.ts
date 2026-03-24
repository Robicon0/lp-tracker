import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";

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

// aToken detection: AAVE V3 uses "aBas", "aArb", "aOpt", "aEth", "aPol" prefixes
// AAVE V2 uses "aUSDC", "aWETH", etc. directly
function getATokenUnderlying(symbol: string): string | null {
  if (symbol.length < 3) return null;
  if (!symbol.startsWith("a") && !symbol.startsWith("A")) return null;
  const rest = symbol.slice(1);
  // Chain-prefixed: aBasUSDC → USDC, aArb... → ...
  for (const prefix of ["Bas", "Arb", "Opt", "Eth", "Pol"]) {
    if (rest.startsWith(prefix)) return rest.slice(prefix.length);
  }
  // Direct: aUSDC, aWETH (AAVE V2 Ethereum)
  if (/^[A-Z]/.test(rest) && rest.length >= 2) return rest;
  return null;
}

function isLendingToken(symbol: string): boolean {
  return getATokenUnderlying(symbol) !== null;
}

export interface WalletTokensData {
  totalTokenValue: number;
  totalLendingValue: number;
  tokenCount: number;
  lendingCount: number;
  isLoading: boolean;
}

export function useWalletTokens(): WalletTokensData {
  const { address } = useAccount();
  const fetchedForRef = useRef<string | null>(null);

  const [data, setData] = useState<WalletTokensData>({
    totalTokenValue: 0,
    totalLendingValue: 0,
    tokenCount: 0,
    lendingCount: 0,
    isLoading: false,
  });

  useEffect(() => {
    if (!address || fetchedForRef.current === address) return;
    if (!process.env.NEXT_PUBLIC_ALCHEMY_KEY) return;

    fetchedForRef.current = address;
    let cancelled = false;
    setData((prev) => ({ ...prev, isLoading: true }));

    (async () => {
      // Fetch ETH + BTC prices for non-stable tokens
      let ethPrice = 0;
      let btcPrice = 0;
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd",
        ).then((r) => r.json());
        ethPrice = res?.ethereum?.usd ?? 0;
        btcPrice = res?.bitcoin?.usd ?? 0;
      } catch { /* price remains 0, unknown tokens won't have USD value */ }

      function priceOf(symbol: string): number {
        const s = symbol.toUpperCase();
        if (STABLE_SYMBOLS.has(s)) return 1;
        if (s === "ETH" || s === "WETH" || s === "STETH" || s === "WSTETH") return ethPrice;
        if (s === "BTC" || s === "WBTC" || s === "CBBTC" || s === "TBTC") return btcPrice;
        // aToken: look up underlying price
        const underlying = getATokenUnderlying(symbol);
        if (underlying) return priceOf(underlying);
        return 0;
      }

      const tokens: Array<{ symbol: string; usdValue: number; isLending: boolean }> = [];

      await Promise.allSettled(
        CHAINS.map(async (chain) => {
          const post = (body: object) =>
            fetch(chain.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }).then((r) => r.json());

          try {
            const balRes = await post({
              jsonrpc: "2.0", id: 1,
              method: "alchemy_getTokenBalances",
              params: [address, "erc20"],
            });
            const nonZero = (balRes.result?.tokenBalances ?? []).filter(
              (t: { tokenBalance: string }) => t.tokenBalance && t.tokenBalance !== ZERO_HEX,
            );
            const top = nonZero.slice(0, 12);

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
                  const usdValue = balance * priceOf(m.symbol);
                  if (!cancelled) {
                    tokens.push({ symbol: m.symbol, usdValue, isLending: isLendingToken(m.symbol) });
                  }
                } catch { /* skip bad token */ }
              }),
            );
          } catch { /* skip chain on error */ }
        }),
      );

      if (cancelled) return;

      const regular = tokens.filter((t) => !t.isLending);
      const lending = tokens.filter((t) => t.isLending);

      setData({
        totalTokenValue: regular.reduce((s, t) => s + t.usdValue, 0),
        totalLendingValue: lending.reduce((s, t) => s + t.usdValue, 0),
        tokenCount: regular.length,
        lendingCount: lending.length,
        isLoading: false,
      });
    })();

    return () => { cancelled = true; };
  }, [address]);

  return data;
}
