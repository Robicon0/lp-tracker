"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Navbar from "../Navbar";
import { useWatchedWallets, type WatchedWalletChain } from "../contexts/WatchedWalletsContext";

const CHAIN_LABELS: Record<WatchedWalletChain, string> = {
  evm:    "EVM",
  solana: "SOL",
  sui:    "SUI",
  aptos:  "APT",
};

function validateAddress(addr: string, chain: WatchedWalletChain): string {
  if (!addr.trim()) return "Address is required";
  if (chain === "evm"    && !/^0x[0-9a-fA-F]{40}$/.test(addr))         return "Invalid EVM address";
  if (chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return "Invalid Solana address";
  if (chain === "sui"    && !/^0x[0-9a-fA-F]{63,64}$/.test(addr))      return "Invalid Sui address";
  if (chain === "aptos"  && !/^0x[0-9a-fA-F]{64}$/.test(addr))         return "Invalid Aptos address";
  return "";
}

export default function WatchedPage() {
  const { watchedWallets, addWallet, removeWallet, updateLabel } = useWatchedWallets();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // New wallet form
  const [addInput, setAddInput]     = useState("");
  const [addChain, setAddChain]     = useState<WatchedWalletChain>("evm");
  const [addLabel, setAddLabel]     = useState("");
  const [addError, setAddError]     = useState("");

  // Inline label editing
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue,  setEditValue]  = useState("");

  function handleAdd() {
    const err = validateAddress(addInput.trim(), addChain);
    if (err) { setAddError(err); return; }
    addWallet(addInput.trim(), addChain, addLabel.trim() || undefined);
    setAddInput(""); setAddLabel(""); setAddError("");
  }

  function startEdit(key: string, current: string) {
    setEditingKey(key);
    setEditValue(current);
  }

  function commitEdit(address: string, chain: WatchedWalletChain) {
    updateLabel(address, chain, editValue);
    setEditingKey(null);
  }

  return (
    <div className="p-8 pt-24 bg-[#0a0f0d] text-white min-h-screen">
      <Navbar />
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <Link href="/dashboard" className="text-emerald-400/40 hover:text-emerald-300 transition-colors text-sm">
            ← Dashboard
          </Link>
          <h1 className="text-3xl font-bold">Watched Wallets</h1>
        </div>

        {/* Watched list */}
        {mounted && watchedWallets.length === 0 && (
          <p className="text-emerald-400/40 mb-8">No watched wallets yet. Add one below.</p>
        )}

        {mounted && watchedWallets.length > 0 && (
          <div className="space-y-3 mb-8">
            {watchedWallets.map((w) => {
              const key = `${w.chain}:${w.address}`;
              const short = w.address.length > 16
                ? `${w.address.slice(0, 8)}...${w.address.slice(-6)}`
                : w.address;
              return (
                <div key={key} className="bg-emerald-950/30 border border-emerald-400/15 rounded-xl p-4 flex items-center gap-4">
                  <span className="text-xs font-mono bg-emerald-900/20 text-emerald-300/70 px-2 py-1 rounded shrink-0">
                    {CHAIN_LABELS[w.chain]}
                  </span>
                  <span className="font-mono text-sm text-gray-300 shrink-0">{short}</span>
                  <div className="flex-1">
                    {editingKey === key ? (
                      <div className="flex gap-2">
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit(w.address, w.chain);
                            if (e.key === "Escape") setEditingKey(null);
                          }}
                          placeholder="Nickname"
                          className="bg-[#0a1f17] border border-emerald-800/50 text-white rounded px-2 py-1 text-sm focus:outline-none focus:border-emerald-400"
                        />
                        <button
                          onClick={() => commitEdit(w.address, w.chain)}
                          className="text-emerald-400 hover:text-emerald-300 text-sm"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingKey(null)}
                          className="text-gray-500 hover:text-gray-300 text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEdit(key, w.label ?? "")}
                        className="text-emerald-400/40 hover:text-emerald-300 text-sm transition-colors text-left"
                      >
                        {w.label ? (
                          <span className="text-emerald-300/80">{w.label}</span>
                        ) : (
                          <span className="italic">Add label…</span>
                        )}
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => removeWallet(w.address, w.chain)}
                    className="text-red-500 hover:text-red-400 text-sm transition-colors shrink-0"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add wallet form */}
        <div className="bg-emerald-950/30 border border-emerald-400/15 rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Add Wallet</h2>
          <div className="flex flex-col gap-3">
            <div className="flex gap-3">
              <input
                type="text"
                value={addInput}
                onChange={(e) => { setAddInput(e.target.value); setAddError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="Paste wallet address"
                className="flex-1 bg-[#0a1f17] border border-emerald-800/50 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-400"
              />
              <select
                value={addChain}
                onChange={(e) => { setAddChain(e.target.value as WatchedWalletChain); setAddError(""); }}
                className="bg-[#0a1f17] border border-emerald-800/50 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-400 shrink-0"
              >
                <option value="evm">EVM</option>
                <option value="solana">Solana</option>
                <option value="sui">Sui</option>
                <option value="aptos">Aptos</option>
              </select>
            </div>
            <input
              type="text"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="Nickname (optional)"
              className="bg-[#0a1f17] border border-emerald-800/50 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-400"
            />
            {addError && <p className="text-red-400 text-xs">{addError}</p>}
            <button
              onClick={handleAdd}
              className="bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors self-start"
            >
              Add Wallet
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
