// Sui live-state reads over GraphQL (2026-10-23). No network: fetch is stubbed.
//   npx tsx scripts/sui-graphql-test.ts
// Live checks (three Cetus positions recomputed from raw chain state, Bluefin /
// Momentum holders) are in the CLAUDE.md entry for this change.

import { toRpcValue, rpcTypeString, nameBcs } from '../app/lib/suiGraphql';
import { suiRpc, suiRpcOrThrow, isSuiReadError } from '../app/lib/suiRpc';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const F = '0x0000000000000000000000000000000000000000000000000000000000000002';
const S1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
const str = (t: string) => ({ struct: { type: t, fields: [{ name: 'bytes', layout: { vector: 'u8' } }] } });
const ID = { struct: { type: `${F}::object::ID`, fields: [{ name: 'bytes', layout: 'address' }] } };
const UID = { struct: { type: `${F}::object::UID`, fields: [{ name: 'id', layout: ID }] } };
const POS = {
  struct: {
    type: '0x1eab::position::Position',
    fields: [
      { name: 'id', layout: UID },
      { name: 'pool', layout: ID },
      { name: 'coin_type_a', layout: { struct: { type: `${S1}::type_name::TypeName`, fields: [{ name: 'name', layout: str(`${S1}::ascii::String`) }] } } },
      { name: 'tick', layout: { struct: { type: '0x714a::i32::I32', fields: [{ name: 'bits', layout: 'u32' }] } } },
      { name: 'liquidity', layout: 'u128' },
      { name: 'bytes', layout: { vector: 'u8' } },
      { name: 'bal', layout: { struct: { type: `${F}::balance::Balance<${F}::sui::SUI>`, fields: [{ name: 'value', layout: 'u64' }] } } },
      { name: 'opt', layout: { struct: { type: `${S1}::option::Option<u64>`, fields: [{ name: 'vec', layout: { vector: 'u64' } }] } } },
      { name: 'none', layout: { struct: { type: `${S1}::option::Option<u64>`, fields: [{ name: 'vec', layout: { vector: 'u64' } }] } } },
      { name: 'url', layout: str(`${S1}::string::String`) },
    ],
  },
};

// ── rendering ────────────────────────────────────────────────────────────────
{
  const v = toRpcValue({
    id: '0xabc', pool: '0xdef', coin_type_a: 'dba3::usdc::USDC', tick: { bits: 67680 }, liquidity: '34',
    bytes: 'AEtVZA==', bal: { value: '5' }, opt: '7', none: null, url: 'https://x',
  }, POS) as { type: string; fields: Record<string, unknown> };
  check('struct → { type, fields }', v.type === '0x1eab::position::Position');
  check('UID → { id }', eq(v.fields.id, { id: '0xabc' }));
  check('ID → string', v.fields.pool === '0xdef');
  check('TypeName (flattened by GraphQL) → { type, fields: { name } }',
    eq(v.fields.coin_type_a, { type: '0x1::type_name::TypeName', fields: { name: 'dba3::usdc::USDC' } }), JSON.stringify(v.fields.coin_type_a));
  check('I32 → { type, fields: { bits } }', eq(v.fields.tick, { type: '0x714a::i32::I32', fields: { bits: 67680 } }));
  check('u128 stays a string', v.fields.liquidity === '34');
  check('vector<u8> base64 → numbers', eq(v.fields.bytes, [0, 75, 85, 100]));
  check('Balance → value string', v.fields.bal === '5');
  check('Option some → value', v.fields.opt === '7');
  check('Option none → null', v.fields.none === null);
  check('String → string', v.fields.url === 'https://x');
  check('Option as { vec: [] } → null', toRpcValue({ vec: [] }, POS.struct.fields[7].layout) === null);
}
check('type strings drop leading address zeros',
  rpcTypeString(`${F}::coin::Coin<0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS>`)
    === '0x2::coin::Coin<0x6864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS>');

// ── dynamic-field names ──────────────────────────────────────────────────────
check('u64 name BCS', nameBcs('u64', '443636') === Buffer.from([0xf4, 0xc4, 0x06, 0, 0, 0, 0, 0]).toString('base64'));
check('I32 name BCS (u32 LE)', nameBcs('0x714a::i32::I32', { bits: 4294967295 }) === Buffer.from([255, 255, 255, 255]).toString('base64'));
check('ID name BCS is 32 bytes', Buffer.from(nameBcs('0x2::object::ID', '0x1'), 'base64').length === 32);
let threw = false;
try { nameBcs('0x2::kiosk::Listing', {}); } catch { threw = true; }
check('unsupported name type throws (never guessed)', threw);

// ── transport ────────────────────────────────────────────────────────────────
type Handler = (body: { query: string; variables?: Record<string, unknown> }) => Response | Promise<Response>;
function stub(h: Handler) {
  let n = 0;
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => { n += 1; return h(JSON.parse(String(init?.body))); }) as typeof fetch;
  return () => n;
}
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });

(async () => {
  // Owned objects: JSON-RPC page shape, with content built from the layout.
  stub((b) => {
    if (b.query.includes('layout')) return ok({ t0: { layout: POS } });
    return ok({ address: { objects: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [
      { address: '0xabc', version: 9, digest: 'd', hasPublicTransfer: true, contents: { type: { repr: '0x1eab::position::Position' }, json: { id: '0xabc', pool: '0xdef', coin_type_a: 'a::b::C', tick: { bits: 1 }, liquidity: '1', bytes: '', bal: '1', opt: null, none: null, url: '' } } },
    ] } } });
  });
  const page = (await suiRpc('suix_getOwnedObjects', ['0x1', { filter: { StructType: '0x1eab::position::Position' }, options: { showContent: true } }, null, 50])) as {
    data: Array<{ data: { objectId: string; version: string; content: { dataType: string; fields: Record<string, unknown> } } }>; nextCursor: string; hasNextPage: boolean;
  };
  check('owned objects: page shape', page.data.length === 1 && page.nextCursor === 'c1' && page.hasNextPage === true);
  check('owned objects: objectId / version string', page.data[0].data.objectId === '0xabc' && page.data[0].data.version === '9');
  check('owned objects: content.fields', page.data[0].data.content.dataType === 'moveObject' && page.data[0].data.content.fields.pool === '0xdef');

  // A missing object is a JSON-RPC "notExists", not a failure.
  stub(() => ok({ object: null }));
  const missing = (await suiRpc('sui_getObject', ['0x9', { showType: true }])) as { error?: { code: string } };
  check('missing object → notExists', missing?.error?.code === 'notExists');

  // Balances: every page is read; types in JSON-RPC form.
  let calls = 0;
  stub((b) => {
    calls += 1;
    const after = b.variables?.a;
    return ok({ address: { balances: {
      pageInfo: { hasNextPage: !after, endCursor: after ? null : 'p2' },
      nodes: [{ coinType: { repr: after ? '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI' : '0xdba3::usdc::USDC' }, totalBalance: after ? '10' : '20' }],
    } } });
  });
  const bals = (await suiRpc('suix_getAllBalances', ['0x1'])) as Array<{ coinType: string; totalBalance: string }>;
  check('balances: both pages read', bals.length === 2 && calls === 2);
  check('balances: SUI as 0x2::sui::SUI', bals.some((x) => x.coinType === '0x2::sui::SUI' && x.totalBalance === '10'));

  // Balances that never end → failure, never a truncated list.
  stub(() => ok({ address: { balances: { pageInfo: { hasNextPage: true, endCursor: 'x' }, nodes: [] } } }));
  check('balances: page cap → undefined (not a short list)', (await suiRpc('suix_getAllBalances', ['0x1'])) === undefined);

  // Outage: 503 on every attempt → undefined from suiRpc, SuiReadError from suiRpcOrThrow.
  const count = stub(() => new Response('down', { status: 503 }));
  check('outage: suiRpc answers undefined', (await suiRpc('suix_getOwnedObjects', ['0x1', {}, null, 50])) === undefined);
  check('outage: retried before giving up', count() === 4, String(count()));
  let err: unknown = null;
  try { await suiRpcOrThrow('suix_getAllBalances', ['0x1']); } catch (e) { err = e; }
  check('outage: suiRpcOrThrow throws SuiReadError', isSuiReadError(err));

  // A GraphQL validation error is not retried.
  const vcount = stub(() => new Response(JSON.stringify({ errors: [{ message: 'Unknown field "x"' }] }), { status: 200 }));
  await suiRpc('suix_getCoinMetadata', ['0x2::sui::SUI']);
  check('validation error: one attempt', vcount() === 1, String(vcount()));

  // Coin metadata shape; unknown coin → null.
  stub(() => ok({ coinMetadata: { decimals: 9, symbol: 'SUI', name: 'Sui', description: '', iconUrl: null, address: '0x9' } }));
  const meta = (await suiRpc('suix_getCoinMetadata', ['0x2::sui::SUI'])) as { decimals: number; symbol: string };
  check('coin metadata', meta.decimals === 9 && meta.symbol === 'SUI');
  stub(() => ok({ coinMetadata: null }));
  check('unknown coin → null', (await suiRpc('suix_getCoinMetadata', ['0x2::x::X'])) === null);

  // Dynamic field: Field wrapper object, rendered like JSON-RPC.
  const FIELD = { struct: { type: `${F}::dynamic_field::Field<u64,u64>`, fields: [{ name: 'id', layout: UID }, { name: 'name', layout: 'u64' }, { name: 'value', layout: 'u64' }] } };
  stub((b) => b.query.includes('layout')
    ? ok({ t0: { layout: FIELD } })
    : ok({ q0: { df: { address: '0xf', version: 1, digest: 'd', contents: { type: { repr: `${F}::dynamic_field::Field<u64,u64>` }, json: { id: '0xf', name: '3', value: '4' } } }, dof: null } }));
  const df = (await suiRpc('suix_getDynamicFieldObject', ['0xp', { type: 'u64', value: '3' }])) as { data: { content: { fields: Record<string, unknown> } } };
  check('dynamic field: { id, name, value }', eq(df.data.content.fields, { id: { id: '0xf' }, name: '3', value: '4' }), JSON.stringify(df.data.content.fields));

  // Concurrent dynamic-field reads share one request; a missing one is "not found".
  const dfCount = stub((b) => {
    if (b.query.includes('layout')) return ok({ t0: { layout: FIELD } });
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(b.variables ?? {}).filter((v) => v.startsWith('p'))) {
      const i = k.slice(1);
      out[`q${i}`] = i === '1' ? { df: null, dof: null } : { df: { address: '0xf' + i, version: 1, digest: 'd', contents: { type: { repr: `${F}::dynamic_field::Field<u64,u64>` }, json: { id: '0xf' + i, name: i, value: '9' } } }, dof: null };
    }
    return ok(out);
  });
  const many = (await Promise.all([0, 1, 2].map((i) => suiRpc('suix_getDynamicFieldObject', ['0xp', { type: 'u64', value: String(i) }])))) as Array<{ data?: { content: { fields: { name: string } } }; error?: { code: string } }>;
  check('dynamic fields: three reads, one request', dfCount() === 1, String(dfCount()));
  check('dynamic fields: answers stay in order', many[0].data?.content.fields.name === '0' && many[2].data?.content.fields.name === '2');
  check('dynamic fields: missing one → dynamicFieldNotFound', many[1].error?.code === 'dynamicFieldNotFound');
  stub(() => new Response('down', { status: 503 }));
  const failed = await Promise.all([0, 1].map((i) => suiRpc('suix_getDynamicFieldObject', ['0xp', { type: 'u64', value: String(i) }])));
  check('dynamic fields: failed batch → every read undefined (never "not found")', failed.every((x) => x === undefined));

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
