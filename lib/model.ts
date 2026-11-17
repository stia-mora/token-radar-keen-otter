// Token Radar model radar-2: one sealed snapshot in, one ranked board out.
//
// Board scope (stricter than the starter, and the same rule the watchlist
// itself uses): a protocol is rankable only when it records no token
// (no market cap, no CoinGecko id, no symbol) AND it is not a CEX, a
// bridge, a liquid-staking / liquid-restaking product, a staking pool,
// a stablecoin wrapper, an anchor / decentralised BTC product, a
// versioned pool (name ending in V2 / 2.0 and the like), a wrapped /
// staked / restaked product, or an exchange-branded product. That keeps
// wrapped BTC, staked ETH and exchanges out of a board that is about
// tokens that do not exist yet. Every watchlist slug passes this test,
// so coverage is never at risk. In this snapshot 190 protocols are
// rankable: the 40 watchlist rows plus 150 more below the floor.
// The board ranks all 190.
//
// Implied value follows only from the snapshot's own figures, on a log
// scale, so one whale TVL cannot swallow the whole ranking:
//
//   size     = clamp((log10(tvl) - log10(5,000,000)) /
//                    (log10(14,000,000,000) - log10(5,000,000)), 0, 1)
//   growth   = clamp(change_7d, -60, 120);  growthScore = (growth + 60) / 180
//              (change_7d null counts as 0% growth, never as a bonus)
//   age      = days from listed_at to as_of, capped at 1095
//              ageScore = log1p(age) / log1p(1095)
//              (listed_at null counts as 365 days, the median-ish age)
//   breadth  = log2(1 + min(chains, 10)) / log2(11)
//   score    = 0.45*size + 0.25*growthScore + 0.20*ageScore + 0.10*breadth
//   implied  = round(1,000,000 * 10^(score * 2.7), to the nearest $1,000)
//
// Why log TVL: a launch is not worth a fixed fraction of TVL. Doubling
// TVL from $50M to $100M says far more about a protocol than doubling
// it from $2B to $4B, and a linear model ranks by TVL alone. The log
// scale lets growth, time running with no token, and chain breadth
// move a protocol up or down the board. No protocol name is ever
// special-cased: the same function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  size_weight: number;
  growth_weight: number;
  age_weight: number;
  breadth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_days: number;
  unknown_age_days: number;
  log_exponent: number;
  base_usd: number;
}

export const MODEL: ModelConstants = {
  size_weight: 0.45,
  growth_weight: 0.25,
  age_weight: 0.2,
  breadth_weight: 0.1,
  growth_floor: -60,
  growth_cap: 120,
  maturity_days: 1095,
  unknown_age_days: 365,
  log_exponent: 2.7,
  base_usd: 1_000_000,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  is_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    size_score: number;
    growth_score: number;
    age_score: number;
    breadth_score: number;
    composite_score: number;
    growth_pct: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  is_watchlist: boolean;
  size_score: number;
  growth_score: number;
  age_score: number;
  breadth_score: number;
  composite_score: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The four component scores and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; size: number; growthScore: number; ageScore: number; breadth: number; composite: number; growthPct: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const size = Math.min(
    1,
    Math.max(0, (Math.log10(Math.max(protocol.tvl_usd, 1)) - Math.log10(5_000_000)) / (Math.log10(14_000_000_000) - Math.log10(5_000_000))),
  );
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthScore = (growthPct - model.growth_floor) / (model.growth_cap - model.growth_floor);
  const ageForModel = age ?? model.unknown_age_days;
  const ageScore = Math.log1p(Math.min(Math.max(ageForModel, 0), model.maturity_days)) / Math.log1p(model.maturity_days);
  const breadth = Math.log2(1 + Math.min(protocol.chains.length, 10)) / Math.log2(11);
  const composite = model.size_weight * size + model.growth_weight * growthScore + model.age_weight * ageScore + model.breadth_weight * breadth;
  const implied = Math.max(1_000, Math.round((model.base_usd * 10 ** (composite * model.log_exponent)) / 1000) * 1000);
  return { implied, size, growthScore, ageScore, breadth, composite, growthPct, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word wrapped / staked / staking / restaking in a name: a product of a token that already trades. */
const WRAPPED = /\b(wrapped|staked|staking|restaking)\b/i;

/** Categories the watchlist rule keeps out of a pre-token board, plus
 *  wrapper / pegged-BTC / staking-pool categories that are the same
 *  kind of product under another name. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
  'Staking Pool', 'Stablecoin Wrapper', 'Anchor BTC', 'Decentralized BTC',
]);

/** Exchange names a protocol name must not begin with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked, bridged, exchange or versioned product. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, not just
  // the biggest by TVL. The watchlist is the floor, never the ceiling.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    is_watchlist: snapshot.watchlist.includes(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      size_score: round4(s.v.size),
      growth_score: round4(s.v.growthScore),
      age_score: round4(s.v.ageScore),
      breadth_score: round4(s.v.breadth),
      composite_score: round4(s.v.composite),
      growth_pct: s.v.growthPct,
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Typical gas for one transaction on a chain, from the chain's own fees. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return 'about $8 to $20 of gas';
  if (chain === 'Solana') return 'under $0.10 of gas';
  if (chain === 'Bitcoin') return 'about $2 of network fees';
  return 'about $0.50 to $2 of gas';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 90) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator') || c.includes('capital allocator') || c.includes('allocator') || c.includes('curator')) {
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares for the whole farming window.`;
  }
  if (c.includes('uncollateralized lend') || c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}, borrow no more than 40% against it, and keep the position healthy.`;
  }
  if (c.includes('dex') || c.includes('liquidity manager') || c.includes('leveraged farm')) {
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} in a narrow range and keep the position open.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and let it auto-compound.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the farming wallet.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis trading')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position, not a leveraged bet.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and place one small position in a market that settles after the farming window.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it for the farming window.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the farming window.`;
  }
  if (c.includes('payment') || c.includes('card')) {
    return `Route $${capital} of spending through ${name} on ${chain} over the farming window, in small weekly amounts.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app the same week.`;
  }
  if (c.includes('restak') || c.includes('staking')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the farming window.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a
 * time. The plan is derived from the protocol's own record (category,
 * chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const action = actionFor(p, capital, chain);
  const chainsText = p.chains.length > 1 ? ` It also runs on ${p.chains.slice(1, 3).join(' and ')}.` : '';
  return [
    {
      text: `Use a fresh wallet that holds only the $${capital} you plan to farm, and keep its seed phrase offline.`,
      cost: 'no cost to create the wallet',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week on ${chain}, such as a deposit, a borrow, a swap or a vote, so the wallet looks active in every snapshot.${chainsText}`,
      cost: `${gas} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot, and do not withdraw early for a small gain.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check the protocol's own points or rewards page weekly, and claim only from the link it publishes; never pay a fee to claim and never sign a blind approval.`,
      cost: 'no fee to check',
      time: '10 minutes a week',
    },
    {
      text: `If ${p.name} runs on more than one chain, repeat the smallest qualifying action on a second chain once, so the wallet is not a single-chain tourist.`,
      cost: gas,
      time: '15 minutes, once',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log so you can repeat the position, prove the activity, or unwind it cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, farm plan included so page and board agree exactly. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    is_watchlist: row.is_watchlist,
    size_score: row.model.size_score,
    growth_score: row.model.growth_score,
    age_score: row.model.age_score,
    breadth_score: row.model.breadth_score,
    composite_score: row.model.composite_score,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
