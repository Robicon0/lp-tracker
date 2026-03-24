import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
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

  useEffect(() => {
    if (!address || fetchedForRef.current === address) return;
    if (!process.env.NEXT_PUBLIC_ALCHEMY_KEY) return;

    fetchedForRef.current = address;
    let cancelled = false;
    setData((prev) => ({ ...prev, isLoading: true }));

    (async () => {
      // Fetch prices for common non-stable tokens
      const prices: Record<string, number> = {};
      try {
        const res = await fetch(
          "/api/prices?endpoint=simple/price&ids=ethereum,bitcoin,solana,sui,matic-network,arbitrum,optimism,binancecoin,avalanche-2&vs_currencies=usd",
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
      } catch { /* continue with 0 prices */ }

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
                      chain: chain.name,
                      logo: m.logo || getTokenLogo(m.symbol) || "",
                      isLending: lending,
                      isDebt: debt,
                      contractAddress: token.contractAddress,
                    });
                  }
                } catch { /* skip bad token */ }
              }),
            );
          } catch { /* skip chain on error */ }
        }),
      );

      if (cancelled) return;

      const regular  = tokens.filter((t) => !t.isLending && !t.isDebt);
      const lending  = tokens.filter((t) => t.isLending);
      const debt     = tokens.filter((t) => t.isDebt);

      setData({
        tokens,
        totalTokenValue:  regular.reduce((s, t) => s + t.usdValue, 0),
        totalLendingValue: lending.reduce((s, t) => s + t.usdValue, 0),
        totalDebtValue:   debt.reduce((s, t) => s + t.usdValue, 0),
        tokenCount:  regular.length,
        lendingCount: lending.length,
        isLoading: false,
      });
    })();

    return () => { cancelled = true; };
  }, [address]);

  return data;
}
