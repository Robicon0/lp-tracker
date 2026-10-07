# Aerodrome position reconciliation — Account 1

Date: 2026-10-07 · Source: Base chain only (public data). No calculator or spreadsheet data is in this file.

Wallet: `0xD99a9e66d000d4024dC77f00f784Cc45F8804F20` (Account 1 / RAKA, EVM)
Position manager: `0x827922686190790b37229fd06084350E74485b72` (Aerodrome Slipstream, Base)

## Summary

- 14 positions ever held: 13 closed (NFT burned), 1 open.
- Closed positions: deposited $102,982.37, withdrawn $101,337.90, **Capital G/L −$1,644.47**.
- Fees collected, all 14 positions: **$2,533.41**.

## Positions

Dates are UTC. Capital G/L = withdrawn − deposited, closed positions only.

| tokenId | Pair | Opened | Closed | Deposited | Withdrawn | Fees collected | Capital G/L |
|---|---|---|---|---:|---:|---:|---:|
| 50087147 | USDC/cbBTC | 2026-02-08 | 2026-05-06 | $3,249.95 | $3,330.89 | $296.16 | $80.94 |
| 50093212 | WETH/USDC | 2026-02-08 | 2026-06-04 | $3,482.27 | $3,044.90 | $484.75 | -$437.37 |
| 53297598 | WETH/USDC | 2026-02-25 | 2026-03-17 | $6,375.93 | $6,610.51 | $254.10 | $234.58 |
| 59408299 | WETH/USDC | 2026-03-17 | 2026-06-04 | $7,937.69 | $6,364.83 | $441.52 | -$1,572.87 |
| 71729936 | WETH/USDC | 2026-06-05 | 2026-06-05 | $9,246.39 | $9,150.70 | $0.07 | -$95.69 |
| 71734039 | WETH/USDC | 2026-06-05 | 2026-06-05 | $9,153.80 | $8,818.06 | $0.07 | -$335.74 |
| 71735590 | WETH/USDC | 2026-06-05 | 2026-06-05 | $8,878.15 | $8,249.32 | $0.00 | -$628.82 |
| 71749148 | WETH/USDC | 2026-06-05 | 2026-08-27 | $8,184.28 | $9,294.79 | $504.04 | $1,110.51 |
| 75864526 | WETH/USDC | 2026-08-28 | 2026-09-13 | $9,294.79 | $9,294.79 | $238.10 | $0.00 |
| 76633885 | WETH/USDC | 2026-09-13 | 2026-09-19 | $9,294.79 | $9,294.79 | $141.29 | $0.00 |
| 76761205 | WETH/USDC | 2026-09-19 | 2026-09-21 | $9,294.79 | $9,294.79 | $11.87 | $0.00 |
| 76817136 | WETH/USDC | 2026-09-21 | 2026-09-21 | $9,294.78 | $9,294.78 | $0.00 | $0.00 |
| 76817830 | WETH/USDC | 2026-09-21 | 2026-09-21 | $9,294.77 | $9,294.77 | $5.02 | $0.00 |
| 76833100 | WETH/USDC | 2026-09-21 | OPEN | $9,294.77 | — | $156.43 | — |

## Transactions

Open tx = the transaction that minted the position NFT to the wallet. Close tx = the transaction that burned it.

| tokenId | Open block | Open tx | Close block | Close tx | Events |
|---|---:|---|---:|---|---:|
| 50087147 | 41876305 | `0x10a73d5f1a9f7b6a8cd1f3c0e350b29430a38ddf0ae4cdea9e7eaf553915bc9c` | 45629911 | `0x1769a1d3a2c8d9ae155cea25e63afea33e260b7b812899f59552d763aa8f7b7c` | 15 |
| 50093212 | 41878002 | `0x2173454f6a3c5e7147c9ddaa38dd2fb3d8c197f57aacf0eafdc75f1082ac1d66` | 46906204 | `0x89c40ee1867e829d6d0e2821f3910065d40c3b4ab394728eefcb8d0c1aa08189` | 19 |
| 53297598 | 42606438 | `0xfc39618489779aecea773592484176e731db938c1209fcb74e7e00ca19a3fc2b` | 43470642 | `0xd0eb4e33032222adca225113d0b92d51c0294576f7b2b9293d51516fd73b22fd` | 6 |
| 59408299 | 43471554 | `0xeef0631db6e51573346973f746a10d766f733229a5780e089df629cd7964cb2c` | 46906222 | `0x67b8b80215490accb08b50ebb1246413619d9bde4227d7e58cae303e3a96cc2e` | 13 |
| 71729936 | 46916065 | `0x578c841de9add4762ae2fe12972e68663107e2821d919893fc576cf7cc437402` | 46922387 | `0xa22097e24ebfcf56207a3f90a4a80e0c8a276e004484a50f5e5b8ec7e5ea9137` | 3 |
| 71734039 | 46922481 | `0x534f5469daaccc4dd80b7aec28d7e8741ad53a9ba32c2aa32befc737a900b26d` | 46925044 | `0x8738e09b3bba04d40cbe87a9fd1bcd68c0b7f9db4ce6fc99757485acfac1c709` | 3 |
| 71735590 | 46925235 | `0xfc66fefc66c2c98561ae72d27940383fd0e19c2b44ddf2eb49dcd88cd14c632c` | 46949227 | `0x4dabdc51f10bfd987c51a468e5c356bd6ef9e91c4eb52709c7143a736c8261c0` | 3 |
| 71749148 | 46949348 | `0x0fcfac94466380f5db091cde9e724eef004688553b6c4219354b9435016e7072` | 50510113 | `0xa0643113430964cc799db2e261d5b3bf8e1801c60cd609dc3ea8d291e7178cfd` | 12 |
| 75864526 | 50566925 | `0xc759e991d6b0c1953b461138eb8671c9e4bd324ec97ab17f52bb46f190aed02d` | 51245756 | `0xfdb9fb89e73de8be64e2df3f4ce479911db49f05b56085906d7b5c118e76a727` | 4 |
| 76633885 | 51245934 | `0x1ecf5d87710da7a09ec1dff252b92e8b68f74f0ee1f4668fd03e0b86fbdf4a7d` | 51501453 | `0xdd2b9a34abaeb17a206ae3821c1db0b297f831dc3db74965da0cac3909cb5bf7` | 4 |
| 76761205 | 51503291 | `0x6520018a214e478cbb9fb88d25862b5666e33ad5559ec9773823b11007b49f20` | 51595744 | `0x6481f3717fa34b8f8ed76e4bb4e9fec8a1e957024b03c2a85264042d8009164c` | 4 |
| 76817136 | 51596344 | `0x1fc83733946e959a40626c2eec0f0f453af1f5a3f865f1b274d3c2fc7ba7ce05` | 51597084 | `0xe22e66e76bca68aae9f606e1d602274bb3cce3e4ee5b2300dd0e4839948b5b3b` | 3 |
| 76817830 | 51597151 | `0x59aae80ee95e273cf9e9f5ee47063697d17c234ecee7b9aaaa2813e8d9e6c1d6` | 51621995 | `0x80af5b574f78e3f67df2e291d251a88aa915b481932de7fc6f15d4769a1c723c` | 4 |
| 76833100 | 51622337 | `0x6863d59564d0c0b3d608fa1f2617f022b9d84ff451e21ca6055220452f6466e2` | — | — | 2 |

## How the figures were derived

- **Positions:** every position NFT transferred to or from the wallet, from the chain's transfer index.
- **Events:** the receipts of all 82 transactions the wallet sent to the position manager. Each position's
  liquidity added minus liquidity removed equals its on-chain liquidity (zero for the 13 burned ones), so no
  deposit or withdrawal is missing.
- **Deposited / withdrawn:** token amounts from the deposit and withdrawal events, valued at the pool's own
  price in the block of each event. USDC = $1.
- **Fees collected:** collected amounts minus withdrawn principal, valued at the pool price in the collection
  block. A local DefiDesh build reproduced every figure in this table to the cent.
- **Not included:** Aerodrome gauge rewards (AERO) and fees not yet collected on the open position.
- The six positions opened from 2026-08-28 deposit and withdraw the same amount because the position was
  entirely USDC (out of range) each time it was re-ranged.
