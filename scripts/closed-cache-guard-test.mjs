#!/usr/bin/env node
// Never-shrink guard test for the closed-position caches (Sui + Solana).
//
// Seeds an IN-MEMORY store with the real lists production serves for a wallet,
// then injects short, failing and smaller scans and checks the three rules in
// app/lib/closedPositionCache.ts: a rescan never removes or shrinks a stored
// position, found positions never expire, and a short scan is never written.
// It reads two production routes once each and writes nothing anywhere.
//
// USAGE  node scripts/closed-cache-guard-test.mjs [--base URL] [--sui 0x..] [--solana ...]
// Exits 0 when every check passes, 1 otherwise.
import { createHash } from "node:crypto";
import { loadClosedPositionsGuarded } from "../app/lib/closedPositionCache.ts";
const arg=(n,d)=>{const i=process.argv.indexOf(`--${n}`);return i>=0&&process.argv[i+1]?process.argv[i+1]:d;};
const BASE=arg("base","https://www.defidesh.com");
const SUI=arg("sui","0xdce8af889df949cacbef1188e6eb59d70508b76eba4c74cb1c8dc4f34454c30d"), SOL=arg("solana","GndRtybRYe3ShqES4RXpw9hq2MysJRLkjEf99M6PpogC"); // Account 1
const sui=(await (await fetch(`${BASE}/api/sui-closed-positions?account=${SUI}`)).json()).positions??[];
const sol=(await (await fetch(`${BASE}/api/solana-closed-positions?account=${SOL}`)).json()).positions??[];
if(!sui.length||!sol.length){console.log(`cannot seed: Sui ${sui.length}, Solana ${sol.length} positions from ${BASE}`);process.exit(1);}
const h=(v)=>createHash("sha256").update(typeof v==="string"?v:JSON.stringify(v)).digest("hex").slice(0,12);
const DAY=86400; let NOW=Date.parse("2026-10-08T12:00:00Z");
function mem(){ const m=new Map(), exp=new Map(); let writes=[]; return { m, writes:()=>writes, reset:()=>{writes=[]},
  get:async(k)=>{ if(exp.has(k)&&exp.get(k)<=NOW){m.delete(k);exp.delete(k);} return m.has(k)?m.get(k):null; },
  set:async(k,v,o)=>{ writes.push("set "+k.split(":").slice(0,3).join(":")+(o?" ex="+o.ex:"")); m.set(k,v); if(o)exp.set(k,NOW+o.ex*1000); else exp.delete(k); },
  ttl:async(k)=>!m.has(k)?-2:(exp.has(k)?Math.round((exp.get(k)-NOW)/1000):-1), persist:async(k)=>{writes.push("persist "+k.split(":").slice(0,2).join(":"));exp.delete(k);} , seed:(k,v,ex)=>{m.set(k,JSON.stringify(v)); if(ex)exp.set(k,NOW+ex*1000);} }; }
const common={ idOf:(x)=>x.positionId, weightOf:(x)=>x.events.length, isValid:(p)=>!!p&&typeof p.capitalGL==="number"&&Array.isArray(p.events), legacyTtlSeconds:30*DAY, now:()=>NOW };
let pass=0,fail=0; const ok=(name,cond,detail="")=>{ if(cond) pass++; else fail++; console.log((cond?"PASS":"FAIL"),name,detail);};
const short=(list,n)=>list.slice(0,n).map(p=>({...p,events:p.events.slice(0,1)}));   // fewer positions AND fewer events each
const fake=(id)=>({positionId:id,protocol:"x",capitalGL:1,events:[{type:"deposit"}]});

// ───────── SUI: one slot per protocol, exactly as the route calls it
for(const prot of ["cetus","bluefin","momentum"]){ const list=sui.filter(p=>p.protocol===prot), key=`closed_pos_sui_v2:${prot}:w`, B=mem(); NOW=Date.parse("2026-10-08T12:00:00Z");
  B.seed(key,list,11*DAY); const before=B.m.get(key); let scans=0;
  const run=(scan)=>loadClosedPositionsGuarded({...common,backend:B,slots:[{name:prot,key}],emptyTtlSeconds:null,scan:async()=>{scans++;return scan();}});
  let r=await run(async()=>({bySlot:{[prot]:[]},complete:true}));
  ok(`sui ${prot}: fresh list served from cache, no scan`,scans===0&&r.bySlot[prot].length===list.length&&!r.incomplete,`n=${r.bySlot[prot].length}`);
  ok(`sui ${prot}: expiry removed, value untouched`,(await B.ttl(key))===-1&&B.m.get(key)===before,`ttl=${await B.ttl(key)} hash ${h(before)}`);
  NOW+=12*DAY*1000; scans=0;                                                          // past the old expiry date (11 d left) = the 30-day refresh mark
  r=await run(async()=>({bySlot:{[prot]:[...short(list,2),fake("NEW1")]},complete:false}));
  ok(`sui ${prot}: past old expiry + SHORT scan → stored list byte-identical`,scans===1&&B.m.get(key)===before,`hash ${h(B.m.get(key))} stored n=${JSON.parse(B.m.get(key)).length}`);
  ok(`sui ${prot}: SHORT scan → flagged incomplete, nothing dropped`,r.incomplete===true&&list.every(p=>r.bySlot[prot].some(q=>q.positionId===p.positionId&&q.events.length===p.events.length)),`returned n=${r.bySlot[prot].length}`);
  scans=0; r=await run(async()=>({bySlot:{[prot]:[]},complete:true}));
  ok(`sui ${prot}: next load inside 6 h → no rescan, still flagged`,scans===0&&r.incomplete===true&&r.bySlot[prot].length===list.length);
  NOW+=7*3600*1000; scans=0; r=await run(async()=>{throw new Error("rpc down")});
  ok(`sui ${prot}: scan THROWS → cached served, flagged`,scans===1&&r.incomplete&&r.bySlot[prot].length===list.length&&B.m.get(key)===before);
  NOW+=7*3600*1000; r=await run(async()=>({bySlot:{[prot]:[...short(list,1),fake("NEW2")]},complete:true}));
  const stored=JSON.parse(B.m.get(key));
  ok(`sui ${prot}: COMPLETE but smaller scan → only adds`,stored.length===list.length+1&&list.every(p=>stored.some(q=>JSON.stringify(q)===JSON.stringify(p)))&&!r.incomplete&&(await B.ttl(key))===-1,`stored ${list.length}→${stored.length}`);
}
{ const B=mem(), key="closed_pos_sui_v2:cetus:new"; const r=await loadClosedPositionsGuarded({...common,backend:B,slots:[{name:"cetus",key}],emptyTtlSeconds:null,scan:async()=>({bySlot:{cetus:[fake("A")]},complete:false})});
  ok("sui new wallet: SHORT scan → nothing written, flagged",B.m.size===0&&r.incomplete&&r.bySlot.cetus.length===1);
  const r2=await loadClosedPositionsGuarded({...common,backend:B,slots:[{name:"cetus",key}],emptyTtlSeconds:null,scan:async()=>({bySlot:{cetus:[]},complete:true})});
  ok("sui new wallet: complete EMPTY → still never stored",B.m.size===0&&!r2.incomplete); }

// ───────── SOLANA: two slots, one shared scan
{ const B=mem(), ko="closed_pos_solana_v1:orca:w", kr="closed_pos_solana_v1:raydium:w"; NOW=Date.parse("2026-10-08T12:00:00Z");
  B.seed(ko,sol,26*DAY); B.seed(kr,[],3*DAY); const before=B.m.get(ko); let scans=0;
  const run=(scan)=>loadClosedPositionsGuarded({...common,backend:B,slots:[{name:"orca",key:ko},{name:"raydium",key:kr}],emptyTtlSeconds:7*DAY,scan:async()=>{scans++;return scan();}});
  let r=await run(async()=>({bySlot:{},complete:true}));
  ok("solana: both cached → no scan, 40 served",scans===0&&r.bySlot.orca.length===sol.length&&!r.incomplete&&(await B.ttl(ko))===-1&&B.m.get(ko)===before,`n=${r.bySlot.orca.length} hash ${h(before)}`);
  NOW+=4*DAY*1000;                                                                    // the empty Raydium entry expires → the shared scan runs
  r=await run(async()=>({bySlot:{orca:short(sol,4),raydium:[]},complete:false}));
  ok("solana: SHORT scan → Orca list byte-identical, flagged",scans===1&&B.m.get(ko)===before&&r.incomplete&&r.bySlot.orca.length===sol.length,`hash ${h(B.m.get(ko))}`);
  ok("solana: SHORT scan → empty Raydium NOT written",(await B.get(kr))===null);
  r=await run(async()=>({bySlot:{orca:[...short(sol,4),fake("NEWORCA")],raydium:[]},complete:true}));
  const stored=JSON.parse(B.m.get(ko));
  ok("solana: COMPLETE scan → adds the new one, keeps all 40 untouched",stored.length===sol.length+1&&sol.every(p=>stored.some(q=>JSON.stringify(q)===JSON.stringify(p)))&&!r.incomplete,`stored ${sol.length}→${stored.length}`);
  ok("solana: complete EMPTY Raydium stored with its 7-day TTL",(await B.get(kr))==="[]"&&(await B.ttl(kr))===7*DAY); }

// ───────── read-only switch: a local run can never write to the shared store
{ process.env.CLOSED_POS_CACHE_READONLY="1"; process.env.CLOSED_POS_REFRESH_AFTER_SECONDS="0"; const B=mem(), key="closed_pos_sui_v2:cetus:w"; NOW=Date.parse("2026-10-08T12:00:00Z"); const list=sui.filter(p=>p.protocol==="cetus"); B.seed(key,list,11*DAY); B.reset();
  const r=await loadClosedPositionsGuarded({...common,backend:B,slots:[{name:"cetus",key}],emptyTtlSeconds:null,scan:async()=>({bySlot:{cetus:[fake("N")]},complete:true})});
  ok("read-only: forced refresh scans but writes NOTHING",B.writes().length===0&&(await B.ttl(key))===11*DAY&&r.bySlot.cetus.length===list.length+1,`writes=${B.writes().length}`); }
console.log(`\n${pass} passed, ${fail} failed | seeded from production: Sui ${sui.length} (cetus ${sui.filter(p=>p.protocol==="cetus").length}, bluefin ${sui.filter(p=>p.protocol==="bluefin").length}, momentum ${sui.filter(p=>p.protocol==="momentum").length}), Solana ${sol.length}`); process.exit(fail?1:0);
