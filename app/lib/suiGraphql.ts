import { rpcUrlFromEnv } from './rpcEnv';

// Sui live-state reads over GraphQL (2026-10-23).
//
// Sui switched JSON-RPC off on Alchemy and on the public fullnodes ("JSON-RPC has
// been removed on Sui as of Sui v1.82"). The six JSON-RPC methods DefiDesh used
// for LIVE state are answered here from Sui GraphQL (the service suiHistory.ts
// already reads) and returned in the SAME shapes the JSON-RPC methods returned,
// so every route keeps its parser:
//
//   suix_getOwnedObjects  suix_getDynamicFieldObject  suix_getAllBalances
//   sui_multiGetObjects   sui_getObject               suix_getCoinMetadata
//
// Why GraphQL and not gRPC: GraphQL is plain HTTPS + JSON from a serverless
// function (no protobuf toolchain or HTTP/2 client), it is already in use for
// history, and it returns a Move value together with its type layout, which is
// what rebuilds the JSON-RPC rendering exactly (below).
//
// Rendering. GraphQL `contents.json` writes every struct as a plain object and a
// UID as a string; JSON-RPC wrote a struct as { type, fields }, a UID as { id }, a
// vector<u8> as numbers, and type strings with leading address zeros stripped.
// `toRpcValue` walks the value next to its layout (`type.layout`, cached per type
// in this process: a type string names one immutable layout) and writes the
// JSON-RPC form.
//
// Transport: one per-instance limiter for all Sui GraphQL traffic (concurrency
// and a request rate), a timeout per request, backoff on 429 / 5xx / timeouts.
// A read that cannot be answered THROWS SuiGraphqlError; it never becomes an
// empty list (rule (e)). A page that keeps saying "more" past the page cap
// throws too, never a truncated list.

const DEFAULT_ENDPOINT = 'https://graphql.mainnet.sui.io/graphql';
function endpoint(): string { return rpcUrlFromEnv('SUI_GRAPHQL_URL') || DEFAULT_ENDPOINT; }

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;
const MAX_CONCURRENT = 8;
const MAX_PER_SECOND = 25;
const MAX_PAGES = 40; // 2,000 objects / balances per call
const MULTI_GET_CHUNK = 50;

export class SuiGraphqlError extends Error {
  constructor(reason: string) { super(`sui-graphql: ${reason}`); this.name = 'SuiGraphqlError'; }
}

// ── Limiter (shared with suiHistory.ts) ──────────────────────────────────────
let active = 0;
const waiters: Array<() => void> = [];
const sentAt: number[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function rateGate(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] >= 1000) sentAt.shift();
    if (sentAt.length < MAX_PER_SECOND) { sentAt.push(now); return; }
    await sleep(1000 - (now - sentAt[0]) + 5);
  }
}

/** Runs `fn` inside the instance's Sui GraphQL limiter. */
export async function withSuiGqlSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active += 1;
  try { return await fn(); } finally { active -= 1; waiters.shift()?.(); }
}

let requestCount = 0;
/** GraphQL requests sent by this process (for measurements). */
export function suiGqlRequestCount(): number { return requestCount; }

/** One GraphQL request with retries. Throws SuiGraphqlError when it cannot answer. */
export async function suiGql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  return withSuiGqlSlot(async () => {
    let last = 'no attempt';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(400 * 2 ** (attempt - 1) + Math.random() * 200);
      await rateGate();
      requestCount += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.status === 429 || res.status >= 500) {
          last = `http ${res.status}`;
          const retryAfter = Number(res.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter, 5) * 1000);
          continue;
        }
        const json = (await res.json()) as { data?: T | null; errors?: Array<{ message?: string }> };
        if (json.data && !json.errors?.length) return json.data;
        last = json.errors?.[0]?.message?.slice(0, 200) ?? `http ${res.status} without data`;
        if (res.status === 400 || /VALIDATION|parse|Unknown (field|argument)|Invalid/i.test(last)) break;
      } catch (err) {
        last = (err as Error)?.name === 'AbortError' ? 'timeout' : String(err).slice(0, 120);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SuiGraphqlError(last);
  });
}

// ── Layout-driven JSON-RPC rendering ─────────────────────────────────────────
type Layout = string | { vector: Layout } | { struct: { type: string; fields: Array<{ name: string; layout: Layout }> } } | { enum: unknown };

/** Type string as JSON-RPC wrote it: every address without its leading zeros. */
export function rpcTypeString(repr: string): string {
  return repr.replace(/0x([0-9a-fA-F]{1,64})/g, (_m, hex: string) => '0x' + (hex.replace(/^0+/, '') || '0'));
}

function baseName(type: string): string {
  return rpcTypeString(type).replace(/<.*$/, '');
}

function b64ToBytes(s: string): number[] {
  return Array.from(Buffer.from(s, 'base64'));
}

export function toRpcValue(json: unknown, layout: Layout): unknown {
  if (typeof layout === 'string') {
    if (layout === 'address' || layout === 'signer') return json;
    return json; // numbers stay numbers (u8..u32), u64+ stay strings, bool stays bool
  }
  if ('vector' in layout) {
    const inner = layout.vector;
    if (inner === 'u8' && typeof json === 'string') return b64ToBytes(json);
    return Array.isArray(json) ? json.map((v) => toRpcValue(v, inner)) : json;
  }
  if ('struct' in layout) {
    const { type, fields } = layout.struct;
    const name = baseName(type);
    switch (name) {
      case '0x1::string::String':
      case '0x1::ascii::String':
      case '0x2::url::Url':
      case '0x2::object::ID':
        return typeof json === 'object' && json !== null ? Object.values(json)[0] : json;
      case '0x2::object::UID': {
        const id = typeof json === 'string' ? json : (json as { id?: unknown })?.id;
        return { id: typeof id === 'object' && id !== null ? Object.values(id)[0] : id };
      }
      case '0x2::balance::Balance':
        return typeof json === 'object' && json !== null ? (json as { value?: unknown }).value : json;
      case '0x1::option::Option': {
        if (json === null || json === undefined) return null;
        const vecLayout = fields[0]?.layout as { vector: Layout } | undefined;
        const innerLayout = vecLayout && typeof vecLayout === 'object' && 'vector' in vecLayout ? vecLayout.vector : undefined;
        let v: unknown = json;
        if (typeof json === 'object' && json !== null && 'vec' in (json as object)) {
          const arr = (json as { vec: unknown[] }).vec;
          if (!arr.length) return null;
          v = arr[0];
        }
        return innerLayout ? toRpcValue(v, innerLayout) : v;
      }
    }
    // GraphQL writes some one-field structs as the bare inner value
    // (TypeName → "pkg::mod::T"); JSON-RPC kept the field.
    const obj = (json !== null && typeof json !== 'object' && fields.length === 1
      ? { [fields[0].name]: json }
      : (json ?? {})) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f.name] = toRpcValue(obj[f.name], f.layout);
    return { type: rpcTypeString(type), fields: out };
  }
  return json; // Move enums: passed through as GraphQL renders them
}

const layoutMemo = new Map<string, Layout>();

// A type's layout never changes: kept for the life of the instance. Concurrent
// renders share one request per type (without this, every render of a new type
// asked for the same layout again).
const layoutPending = new Map<string, Promise<void>>();

async function layoutsFor(reprs: string[]): Promise<void> {
  const wanted = [...new Set(reprs)].filter((r) => !layoutMemo.has(r));
  const missing = wanted.filter((r) => !layoutPending.has(r));
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const vars: Record<string, string> = {};
    const decl = chunk.map((_, j) => `$t${j}:String!`).join(',');
    const body = chunk.map((r, j) => { vars[`t${j}`] = r; return `t${j}:type(type:$t${j}){layout}`; }).join(' ');
    const p = suiGql<Record<string, { layout?: Layout } | null>>(`query(${decl}){${body}}`, vars).then((data) => {
      chunk.forEach((r, j) => {
        const l = data[`t${j}`]?.layout;
        if (!l) throw new SuiGraphqlError(`no layout for ${r.slice(0, 80)}`);
        layoutMemo.set(r, l);
      });
    });
    // A failed read is not remembered: the next render asks again.
    const settled = p.finally(() => chunk.forEach((r) => layoutPending.delete(r)));
    settled.catch(() => {});
    chunk.forEach((r) => layoutPending.set(r, settled));
  }
  await Promise.all(wanted.map((r) => layoutPending.get(r)));
  for (const r of wanted) if (!layoutMemo.has(r)) throw new SuiGraphqlError(`no layout for ${r.slice(0, 80)}`);
}

// ── Object shapes ────────────────────────────────────────────────────────────
interface GqlMoveObject {
  address: string;
  version: number;
  digest: string;
  hasPublicTransfer?: boolean | null;
  contents?: { type?: { repr?: string }; json?: unknown } | null;
}

const OBJ_FIELDS = 'address version digest hasPublicTransfer contents{type{repr} json}';

interface ObjectOptions { showContent?: boolean; showType?: boolean }

/** The JSON-RPC `SuiObjectResponse.data` for one object. */
async function renderObjects(objs: Array<GqlMoveObject | null>, opts: ObjectOptions): Promise<Array<Record<string, unknown> | null>> {
  if (opts.showContent) await layoutsFor(objs.flatMap((o) => (o?.contents?.type?.repr ? [o.contents.type.repr] : [])));
  return objs.map((o) => {
    if (!o) return null;
    const repr = o.contents?.type?.repr;
    const data: Record<string, unknown> = { objectId: o.address, version: String(o.version), digest: o.digest };
    if ((opts.showType || opts.showContent) && repr) data.type = rpcTypeString(repr);
    if (opts.showContent && repr) {
      const v = toRpcValue(o.contents?.json, layoutMemo.get(repr)!) as { fields?: unknown };
      data.content = { dataType: 'moveObject', type: rpcTypeString(repr), hasPublicTransfer: !!o.hasPublicTransfer, fields: v?.fields ?? {} };
    }
    return data;
  });
}

const notExists = (id: string) => ({ error: { code: 'notExists', object_id: id } });

async function getOwnedObjects(owner: string, query: { filter?: { StructType?: string }; options?: ObjectOptions } | undefined, cursor: string | null | undefined, limit: number | undefined) {
  const type = query?.filter?.StructType;
  const first = Math.min(Math.max(limit ?? 50, 1), 50);
  const data = await suiGql<{ address: { objects: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlMoveObject[] } } | null }>(
    `query($o:SuiAddress!,$t:String,$a:String,$n:Int){address(address:$o){objects(first:$n,after:$a,filter:{type:$t}){pageInfo{hasNextPage endCursor} nodes{${OBJ_FIELDS}}}}}`,
    { o: owner, t: type ?? null, a: cursor ?? null, n: first },
  );
  const conn = data.address?.objects;
  if (!conn) return { data: [], nextCursor: null, hasNextPage: false };
  const rendered = await renderObjects(conn.nodes, query?.options ?? {});
  return { data: rendered.map((d) => ({ data: d })), nextCursor: conn.pageInfo.endCursor, hasNextPage: conn.pageInfo.hasNextPage };
}

async function multiGetObjects(ids: string[], opts: ObjectOptions | undefined) {
  const out: unknown[] = [];
  for (let i = 0; i < ids.length; i += MULTI_GET_CHUNK) {
    const chunk = ids.slice(i, i + MULTI_GET_CHUNK);
    const data = await suiGql<{ multiGetObjects: Array<{ asMoveObject?: GqlMoveObject | null } | null> }>(
      `query($k:[ObjectKey!]!){multiGetObjects(keys:$k){asMoveObject{${OBJ_FIELDS}}}}`,
      { k: chunk.map((address) => ({ address })) },
    );
    const rendered = await renderObjects(data.multiGetObjects.map((o) => o?.asMoveObject ?? null), opts ?? {});
    rendered.forEach((d, j) => out.push(d ? { data: d } : notExists(chunk[j])));
  }
  return out;
}

async function getObject(id: string, opts: ObjectOptions | undefined) {
  const data = await suiGql<{ object: { asMoveObject?: GqlMoveObject | null } | null }>(
    `query($a:SuiAddress!){object(address:$a){asMoveObject{${OBJ_FIELDS}}}}`, { a: id },
  );
  const [d] = await renderObjects([data.object?.asMoveObject ?? null], opts ?? {});
  return d ? { data: d } : notExists(id);
}

// BCS of a dynamic-field name, for the name types DefiDesh looks up.
function leBytes(v: bigint, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return out;
}
function addressBytes(a: string): number[] {
  const hex = a.replace(/^0x/, '').padStart(64, '0');
  return Array.from(Buffer.from(hex, 'hex'));
}
export function nameBcs(type: string, value: unknown): string {
  const t = rpcTypeString(type);
  const ints: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, u256: 32 };
  let bytes: number[];
  if (ints[t]) bytes = leBytes(BigInt(value as string | number), ints[t]);
  else if (t === 'address' || t === '0x2::object::ID') bytes = addressBytes(String(value));
  else if (/::i32::I32$/.test(t) && value && typeof value === 'object' && 'bits' in value) bytes = leBytes(BigInt((value as { bits: number }).bits), 4);
  else throw new SuiGraphqlError(`dynamic-field name type not supported: ${type}`);
  return Buffer.from(bytes).toString('base64');
}

// Dynamic-field reads arrive one by one from many positions at once (Cetus reads
// three per position). They are collected for a few milliseconds and sent as one
// aliased query: about 20 query nodes each against the 300-node limit, so 10 per
// request. A failed request fails every read in it (each caller then sees the
// failure, never a "not found").
const DF_BATCH = 10;
const DF_WINDOW_MS = 5;
const DF_SEL = `df:dynamicField(name:$NAME){${OBJ_FIELDS}} dof:dynamicObjectField(name:$NAME){value{__typename ... on MoveObject{${OBJ_FIELDS}}}}`;
type DfAnswer = { df: GqlMoveObject | null; dof: { value?: (GqlMoveObject & { __typename?: string }) | null } | null } | null;
interface DfJob { parent: string; name: { type: string; bcs: string }; resolve: (v: DfAnswer) => void; reject: (e: unknown) => void }
const dfQueue: DfJob[] = [];
let dfTimer: ReturnType<typeof setTimeout> | null = null;

function flushDynamicFields(): void {
  dfTimer = null;
  while (dfQueue.length) {
    const jobs = dfQueue.splice(0, DF_BATCH);
    const vars: Record<string, unknown> = {};
    const decl = jobs.map((_, i) => `$p${i}:SuiAddress!,$n${i}:DynamicFieldName!`).join(',');
    const body = jobs.map((j, i) => {
      vars[`p${i}`] = j.parent;
      vars[`n${i}`] = j.name;
      return `q${i}:address(address:$p${i}){${DF_SEL.replaceAll('$NAME', `$n${i}`)}}`;
    }).join(' ');
    suiGql<Record<string, DfAnswer>>(`query(${decl}){${body}}`, vars).then(
      (data) => jobs.forEach((j, i) => j.resolve(data[`q${i}`] ?? null)),
      (err) => jobs.forEach((j) => j.reject(err)),
    );
  }
}

function queueDynamicField(parent: string, name: { type: string; bcs: string }): Promise<DfAnswer> {
  return new Promise((resolve, reject) => {
    dfQueue.push({ parent, name, resolve, reject });
    if (dfQueue.length >= DF_BATCH) { if (dfTimer) clearTimeout(dfTimer); flushDynamicFields(); }
    else if (!dfTimer) dfTimer = setTimeout(flushDynamicFields, DF_WINDOW_MS);
  });
}

async function getDynamicFieldObject(parent: string, name: { type: string; value: unknown }) {
  const answer = await queueDynamicField(parent, { type: name.type, bcs: nameBcs(name.type, name.value) });
  const field = answer?.df ?? (answer?.dof?.value?.__typename === 'MoveObject' ? answer.dof.value : null);
  if (!field) return { error: { code: 'dynamicFieldNotFound', parent_object_id: parent } };
  const [d] = await renderObjects([field], { showContent: true, showType: true });
  return { data: d };
}

async function getAllBalances(owner: string) {
  const out: Array<{ coinType: string; totalBalance: string; lockedBalance: Record<string, string> }> = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { address: { balances: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ coinType: { repr: string }; totalBalance: string | null }> } } | null } =
      await suiGql(
        `query($o:SuiAddress!,$a:String){address(address:$o){balances(first:50,after:$a){pageInfo{hasNextPage endCursor} nodes{coinType{repr} totalBalance}}}}`,
        { o: owner, a: after },
      );
    const conn = data.address?.balances;
    if (!conn) return out;
    for (const b of conn.nodes) out.push({ coinType: rpcTypeString(b.coinType.repr), totalBalance: b.totalBalance ?? '0', lockedBalance: {} });
    if (!conn.pageInfo.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new SuiGraphqlError('balances: page cap reached');
}

async function getCoinMetadata(coinType: string) {
  const data = await suiGql<{ coinMetadata: { decimals: number | null; symbol: string | null; name: string | null; description: string | null; iconUrl: string | null; address: string } | null }>(
    `query($c:String!){coinMetadata(coinType:$c){decimals symbol name description iconUrl address}}`, { c: coinType },
  );
  const m = data.coinMetadata;
  if (!m) return null;
  return { decimals: m.decimals, symbol: m.symbol, name: m.name, description: m.description, iconUrl: m.iconUrl, id: m.address };
}

/** The JSON-RPC methods this module answers. */
export const SUI_GQL_METHODS = new Set([
  'suix_getOwnedObjects', 'sui_multiGetObjects', 'sui_getObject',
  'suix_getDynamicFieldObject', 'suix_getAllBalances', 'suix_getCoinMetadata',
]);

/**
 * Answers one of SUI_GQL_METHODS with the JSON-RPC `result` shape.
 * Throws SuiGraphqlError when Sui cannot be read.
 */
export async function suiGqlAsRpc(method: string, params: unknown[]): Promise<unknown> {
  const p = params as never[];
  switch (method) {
    case 'suix_getOwnedObjects': return getOwnedObjects(p[0], p[1], p[2], p[3]);
    case 'sui_multiGetObjects': return multiGetObjects(p[0], p[1]);
    case 'sui_getObject': return getObject(p[0], p[1]);
    case 'suix_getDynamicFieldObject': return getDynamicFieldObject(p[0], p[1]);
    case 'suix_getAllBalances': return getAllBalances(p[0]);
    case 'suix_getCoinMetadata': return getCoinMetadata(p[0]);
  }
  throw new SuiGraphqlError(`method not served over GraphQL: ${method}`);
}
