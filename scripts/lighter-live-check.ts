#!/usr/bin/env tsx
// Read-only live checks for the Lighter integration: the open questions of the Lighter spec (§9) that can be
// answered without an API key or a transaction - Q1-Q3, Q5-Q7, Q17-Q19 and Q23.
//
//   npm run lighter:check -- [--profile mainnet|testnet|robinhood|robinhood_testnet] [--checks Q1,Q6]
//                            [--duration 120] [--market BTC] [--max-sockets 5] [--compare-profiles]
//                            [--account <index>] [--json <file>]
//
// It never signs and never sends a transaction. Public REST and WebSocket reads only. The private parts of Q3
// and Q19 (your own orders) run only when an auth token is supplied in the LIGHTER_AUTH_TOKEN environment
// variable together with --account; the token is never printed. Liquidations are rare on testnet, so the
// liquidation questions (Q1, Q2) are best answered against mainnet, which needs no key.
//
// Exit code: 0 = every check consistent with the bot's assumptions, 1 = at least one warning or error
// (read the report), 2 = bad arguments.

import axios from 'axios';
import { promises as fs } from 'fs';
import WebSocket from 'ws';
import {
  LIGHTER_PROFILE_NAMES,
  PROFILES,
  isLighterProfileName,
  lighterRestUrl,
  lighterStreamUrl,
  type LighterProfile,
  type LighterProfileName,
} from '../src/lib/exchange/lighter/profiles';

export const LIVE_CHECK_IDS = ['Q1', 'Q2', 'Q3', 'Q5', 'Q6', 'Q7', 'Q17', 'Q18', 'Q19', 'Q23'] as const;
export type LiveCheckId = typeof LIVE_CHECK_IDS[number];
export type CheckStatus = 'ok' | 'info' | 'warn' | 'error' | 'skip';

export interface CheckResult {
  id: LiveCheckId;
  title: string;
  status: CheckStatus;
  findings: string[];
  data?: unknown;
}

export interface LiveCheckOptions {
  profile: LighterProfileName;
  checks: ReadonlySet<LiveCheckId>;
  durationMs: number;          // Q1 WebSocket capture
  market: string;              // Backend symbol for Q1, Q3, Q7, Q19 (default BTC)
  maxSockets: number;          // Q5 connection probe
  compareProfiles: boolean;    // Q6 / Q17 across every profile
  accountIndex?: number;       // Q3 / Q19 private parts
  authToken?: string;          // Never printed
}

export interface LiveSocket {
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}

export interface LiveCheckDeps {
  httpGet(url: string, headers?: Record<string, string>): Promise<{ status: number; text: string }>;
  createSocket(url: string): LiveSocket;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

const TWO_POW_53 = BigInt(2) ** BigInt(53);
const OPEN = 1;

// ===== Pure analysis helpers (unit-tested offline) =====

export type TimestampUnit = 's' | 'ms' | 'us' | 'ns';

// Unit of an epoch timestamp by magnitude (the bot normalizes the same way, spec §2.5)
export function inferTimestampUnit(value: unknown): { unit: TimestampUnit; ms: number } | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return { unit: 's', ms: n * 1000 };
  if (n < 1e14) return { unit: 'ms', ms: n };
  if (n < 1e17) return { unit: 'us', ms: Math.floor(n / 1e3) };
  return { unit: 'ns', ms: Math.floor(n / 1e6) };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface MarketInvariantViolation {
  symbol: string;
  marketId: unknown;
  problems: string[];
}

// Spec §3.1 / §9 Q6: every perp has size_decimals + price_decimals == 6, multiplier 1, quote_multiplier 1 and
// supported_* == * (the bot's integer scaling relies on all of them)
export function checkMarketInvariants(details: unknown[]): { checked: number; violations: MarketInvariantViolation[] } {
  const violations: MarketInvariantViolation[] = [];
  let checked = 0;
  for (const raw of details) {
    if (!isRecord(raw) || (raw.market_type !== undefined && raw.market_type !== 'perp')) continue;
    checked++;
    const problems: string[] = [];
    const sd = Number(raw.size_decimals);
    const pd = Number(raw.price_decimals);
    if (!(sd + pd === 6)) problems.push(`size_decimals + price_decimals = ${sd + pd}`);
    if (Number(raw.multiplier ?? 1) !== 1) problems.push(`multiplier ${raw.multiplier}`);
    if (Number(raw.quote_multiplier ?? 1) !== 1) problems.push(`quote_multiplier ${raw.quote_multiplier}`);
    if (raw.supported_size_decimals !== undefined && Number(raw.supported_size_decimals) !== sd) {
      problems.push(`supported_size_decimals ${raw.supported_size_decimals} != ${sd}`);
    }
    if (raw.supported_price_decimals !== undefined && Number(raw.supported_price_decimals) !== pd) {
      problems.push(`supported_price_decimals ${raw.supported_price_decimals} != ${pd}`);
    }
    if (problems.length > 0) violations.push({ symbol: String(raw.symbol), marketId: raw.market_id, problems });
  }
  return { checked, violations };
}

// symbol -> market_id differences between two networks
export function diffMarketIds(a: unknown[], b: unknown[]): { onlyA: string[]; onlyB: string[]; differentIds: string[] } {
  const ids = (list: unknown[]) => new Map(list.filter(isRecord).map(m => [String(m.symbol), m.market_id as unknown]));
  const left = ids(a);
  const right = ids(b);
  const onlyA = [...left.keys()].filter(s => !right.has(s)).sort();
  const onlyB = [...right.keys()].filter(s => !left.has(s)).sort();
  const differentIds = [...left.keys()].filter(s => right.has(s) && right.get(s) !== left.get(s))
    .sort().map(s => `${s} ${String(left.get(s))}/${String(right.get(s))}`);
  return { onlyA, onlyB, differentIds };
}

export interface CapturedFrame {
  at: number;
  raw: string;
  message: unknown;
}

export interface TradeCaptureReport {
  frames: number;
  nullFrames: number;
  types: Record<string, number>;
  ackTypes: string[];
  channelSeparators: string[];
  topLevelKeys: Record<string, string[]>;
  snapshotRows: Record<string, { trades: number; liquidationTrades: number }>;
  tradeTypes: Record<string, number>;
  liquidationRows: number;
  duplicatedAcrossArrays: number;
  serverPingIntervalsMs: number[];
  errors: string[];
}

function tradeId(row: Record<string, any>): string | null {
  if (typeof row.trade_id_str === 'string' && row.trade_id_str !== '') return row.trade_id_str;
  return row.trade_id !== undefined ? String(row.trade_id) : null;
}

// Q1 / Q4: what the trade channels actually send
export function analyzeTradeCapture(frames: CapturedFrame[]): TradeCaptureReport {
  const report: TradeCaptureReport = {
    frames: frames.length,
    nullFrames: 0,
    types: {},
    ackTypes: [],
    channelSeparators: [],
    topLevelKeys: {},
    snapshotRows: {},
    tradeTypes: {},
    liquidationRows: 0,
    duplicatedAcrossArrays: 0,
    serverPingIntervalsMs: [],
    errors: [],
  };
  const separators = new Set<string>();
  let lastPingAt: number | null = null;
  for (const frame of frames) {
    const message = frame.message;
    if (message === null) {
      report.nullFrames++;
      continue;
    }
    if (!isRecord(message)) continue;
    const type = typeof message.type === 'string' ? message.type : message.error ? '(error)' : '(none)';
    report.types[type] = (report.types[type] ?? 0) + 1;
    if (message.error) report.errors.push(JSON.stringify(message.error).slice(0, 200));
    if (type === 'ping') {
      if (lastPingAt !== null) report.serverPingIntervalsMs.push(frame.at - lastPingAt);
      lastPingAt = frame.at;
    }
    if (typeof message.channel === 'string') {
      const match = /^[a-z_]+([:/])/.exec(message.channel);
      if (match) separators.add(match[1]);
    }
    if (type.startsWith('subscribed/') && !report.ackTypes.includes(type)) report.ackTypes.push(type);
    if (/trade/.test(type)) {
      const keys = report.topLevelKeys[type] ?? [];
      for (const key of Object.keys(message)) if (!keys.includes(key)) keys.push(key);
      report.topLevelKeys[type] = keys.sort();

      const trades = Array.isArray(message.trades) ? message.trades.filter(isRecord) : [];
      const liquidations = Array.isArray(message.liquidation_trades) ? message.liquidation_trades.filter(isRecord) : [];
      if (type.startsWith('subscribed/')) {
        report.snapshotRows[String(message.channel)] = { trades: trades.length, liquidationTrades: liquidations.length };
      }
      for (const row of [...trades, ...liquidations]) {
        const rowType = String(row.type ?? '(missing)');
        report.tradeTypes[rowType] = (report.tradeTypes[rowType] ?? 0) + 1;
      }
      if (type.startsWith('update/')) {
        report.liquidationRows += [...trades, ...liquidations].filter(row => row.type === 'liquidation').length;
      }
      const inTrades = new Set(trades.map(tradeId).filter((id): id is string => id !== null));
      report.duplicatedAcrossArrays += liquidations.map(tradeId).filter(id => id !== null && inTrades.has(id)).length;
    }
  }
  report.channelSeparators = [...separators].sort();
  return report;
}

export interface LiquidationRowsReport {
  rows: number;
  isMakerAsk: { true: number; false: number };
  signChanged: number;
  signedSizeBefore: boolean;            // Some taker_position_size_before was negative
  takerIsSystemAccount: number;         // Taker = LLP or account 1
  makerIsSystemAccount: number;         // Counterparty = LLP or account 1
  sampleTakerSide: Array<{ tradeId: string; isMakerAsk: boolean; inferredForcedSide: 'BUY' | 'SELL'; takerSizeBefore: string }>;
}

// Q2: who the liquidated account is (taker rule) and how often the LLP / insurance fund takes the other side
export function analyzeLiquidationRows(rows: unknown[], systemAccounts: number[]): LiquidationRowsReport {
  const report: LiquidationRowsReport = {
    rows: 0,
    isMakerAsk: { true: 0, false: 0 },
    signChanged: 0,
    signedSizeBefore: false,
    takerIsSystemAccount: 0,
    makerIsSystemAccount: 0,
    sampleTakerSide: [],
  };
  const system = new Set(systemAccounts);
  for (const row of rows) {
    if (!isRecord(row) || row.type !== 'liquidation') continue;
    report.rows++;
    const makerAsk = row.is_maker_ask === true;
    report.isMakerAsk[makerAsk ? 'true' : 'false']++;
    if (row.taker_position_sign_changed === true) report.signChanged++;
    if (typeof row.taker_position_size_before === 'string' && row.taker_position_size_before.trim().startsWith('-')) {
      report.signedSizeBefore = true;
    }
    const taker = makerAsk ? row.bid_account_id : row.ask_account_id;
    const maker = makerAsk ? row.ask_account_id : row.bid_account_id;
    if (system.has(Number(taker))) report.takerIsSystemAccount++;
    if (system.has(Number(maker))) report.makerIsSystemAccount++;
    if (report.sampleTakerSide.length < 5) {
      report.sampleTakerSide.push({
        tradeId: tradeId(row) ?? '?',
        isMakerAsk: makerAsk,
        inferredForcedSide: makerAsk ? 'BUY' : 'SELL',
        takerSizeBefore: String(row.taker_position_size_before ?? ''),
      });
    }
  }
  return report;
}

// Q2 (strongest cross-check): a forced SELL prints at or below the last best bid, a forced BUY at or above the
// last best ask. Uses the market_stats/all frames seen before each liquidation in the capture.
export function checkLiquidationsAgainstBbo(frames: CapturedFrame[]): { consistent: number; inconsistent: number; noBbo: number } {
  const bbo = new Map<number, { bid: number | null; ask: number | null }>();
  const result = { consistent: 0, inconsistent: 0, noBbo: 0 };
  const seen = new Set<string>();
  for (const frame of frames) {
    const message = frame.message;
    if (!isRecord(message) || typeof message.type !== 'string') continue;
    if (/market_stats$/.test(message.type) && isRecord(message.market_stats)) {
      for (const [key, value] of Object.entries(message.market_stats)) {
        if (!isRecord(value)) continue;
        const id = Number(value.market_id ?? key);
        const previous = bbo.get(id) ?? { bid: null, ask: null };
        const bid = Number(value.best_bid_price);
        const ask = Number(value.best_ask_price);
        bbo.set(id, {
          bid: 'best_bid_price' in value && bid > 0 ? bid : previous.bid,
          ask: 'best_ask_price' in value && ask > 0 ? ask : previous.ask,
        });
      }
      continue;
    }
    if (!message.type.startsWith('update/trade')) continue;
    const rows = [
      ...(Array.isArray(message.trades) ? message.trades : []),
      ...(Array.isArray(message.liquidation_trades) ? message.liquidation_trades : []),
    ].filter(isRecord).filter(row => row.type === 'liquidation');
    for (const row of rows) {
      const id = tradeId(row);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      const book = bbo.get(Number(row.market_id));
      const price = Number(row.price);
      const forcedSell = row.is_maker_ask !== true;
      const reference = forcedSell ? book?.bid : book?.ask;
      if (reference === null || reference === undefined || !Number.isFinite(price)) {
        result.noBbo++;
      } else if (forcedSell ? price <= reference : price >= reference) {
        result.consistent++;
      } else {
        result.inconsistent++;
      }
    }
  }
  return result;
}

export interface CandleReport {
  count: number;
  ascending: boolean;
  unit: TimestampUnit | null;
  missingVolume: number;
  firstOpenTime: number | null;
}

// Q7: candle order, timestamp unit and empty candles
export function analyzeCandles(body: unknown): CandleReport {
  const candles = isRecord(body) && Array.isArray(body.c) ? body.c.filter(isRecord) : [];
  const times = candles.map(c => Number(c.t));
  return {
    count: candles.length,
    ascending: times.every((t, i) => i === 0 || t >= times[i - 1]),
    unit: candles.length > 0 ? inferTimestampUnit(times[0])?.unit ?? null : null,
    missingVolume: candles.filter(c => c.v === undefined || c.v === null).length,
    firstOpenTime: candles.length > 0 ? times[0] : null,
  };
}

export interface OrderIndexReport {
  orders: number;
  maxDigits: number;
  aboveTwoPow53: number;
  orderIdMatches: number;
  orderIdMissing: number;
}

// Q19: read order_index from the raw text (JSON.parse would round values above 2^53) and compare it with the
// order_id string the bot uses
export function analyzeOrderIndexes(rawText: string): OrderIndexReport {
  const report: OrderIndexReport = { orders: 0, maxDigits: 0, aboveTwoPow53: 0, orderIdMatches: 0, orderIdMissing: 0 };
  const objectPattern = /\{[^{}]*"order_index"\s*:\s*(\d+)[^{}]*\}/g;
  for (const match of rawText.matchAll(objectPattern)) {
    const index = match[1];
    report.orders++;
    report.maxDigits = Math.max(report.maxDigits, index.length);
    if (BigInt(index) > TWO_POW_53) report.aboveTwoPow53++;
    const id = /"order_id"\s*:\s*"(\d+)"/.exec(match[0]);
    if (!id) report.orderIdMissing++;
    else if (id[1] === index) report.orderIdMatches++;
  }
  return report;
}

// Q23: does funding-rates pair Lighter market ids with other venues' symbols?
export function analyzeFundingRates(body: unknown, watch: string[]): { exchanges: Record<string, number>; pairs: Record<string, string[]> } {
  const rows = isRecord(body) && Array.isArray(body.funding_rates) ? body.funding_rates.filter(isRecord) : [];
  const exchanges: Record<string, number> = {};
  const byMarket = new Map<string, string[]>();
  for (const row of rows) {
    const exchange = String(row.exchange ?? '?');
    exchanges[exchange] = (exchanges[exchange] ?? 0) + 1;
    const key = String(row.market_id);
    byMarket.set(key, [...(byMarket.get(key) ?? []), `${exchange}:${String(row.symbol)}`]);
  }
  const pairs: Record<string, string[]> = {};
  for (const symbol of watch) {
    const lighterRow = rows.find(row => String(row.exchange).toLowerCase() === 'lighter' && row.symbol === symbol);
    const sameName = rows.filter(row => String(row.symbol).toUpperCase().includes(symbol.replace(/^1000/, '').toUpperCase()));
    pairs[symbol] = lighterRow
      ? byMarket.get(String(lighterRow.market_id)) ?? []
      : sameName.map(row => `${String(row.exchange)}:${String(row.symbol)} (market ${String(row.market_id)})`);
  }
  return { exchanges, pairs };
}

// ===== Runner =====

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

class Checker {
  private details = new Map<LighterProfileName, unknown[]>();
  private capture: CapturedFrame[] | null = null;
  private llpIndex: number | null = null;

  constructor(private readonly options: LiveCheckOptions, private readonly deps: LiveCheckDeps) {}

  private get profile(): LighterProfile {
    return PROFILES[this.options.profile];
  }

  private async getJson(profile: LighterProfile, path: string, query?: Record<string, string | number | boolean | undefined>, headers?: Record<string, string>) {
    const url = lighterRestUrl(profile, path, query);
    const response = await this.deps.httpGet(url, headers);
    return { status: response.status, text: response.text, body: parseJson(response.text) };
  }

  private async orderBookDetails(profile: LighterProfile): Promise<unknown[]> {
    const cached = this.details.get(profile.name);
    if (cached) return cached;
    const { status, body } = await this.getJson(profile, '/api/v1/orderBookDetails', { filter: 'perp' });
    if (status !== 200 || !isRecord(body) || !Array.isArray(body.order_book_details)) {
      throw new Error(`orderBookDetails on ${profile.name} answered HTTP ${status}`);
    }
    this.details.set(profile.name, body.order_book_details);
    return body.order_book_details;
  }

  private async marketId(symbol: string): Promise<number> {
    const details = await this.orderBookDetails(this.profile);
    const market = details.find(m => isRecord(m) && m.symbol === symbol);
    if (!isRecord(market) || typeof market.market_id !== 'number') {
      throw new Error(`market ${symbol} not found on ${this.profile.name}`);
    }
    return market.market_id;
  }

  private async systemAccounts(): Promise<number[]> {
    if (this.llpIndex === null) {
      const { body } = await this.getJson(this.profile, '/api/v1/systemConfig');
      if (isRecord(body) && typeof body.liquidity_pool_index === 'number') this.llpIndex = body.liquidity_pool_index;
    }
    return this.llpIndex === null ? [1] : [1, this.llpIndex];
  }

  private privateHeaders(): Record<string, string> | null {
    return this.options.authToken && this.options.accountIndex !== undefined ? { authorization: this.options.authToken } : null;
  }

  // ----- WebSocket helpers -----

  private async captureStream(channels: string[], durationMs: number): Promise<CapturedFrame[]> {
    const frames: CapturedFrame[] = [];
    const socket = this.deps.createSocket(lighterStreamUrl(this.profile));
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    socket.on('message', (data: Buffer | string) => {
      const raw = data.toString();
      const message = parseJson(raw);
      if (frames.length < 20_000) frames.push({ at: this.deps.now(), raw, message });
      if (isRecord(message) && message.type === 'ping' && socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'pong' }));
      if (isRecord(message) && message.type === 'connected') {
        for (const channel of channels) socket.send(JSON.stringify({ type: 'subscribe', channel }));
        pingTimer = setInterval(() => {
          if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'ping' }));
        }, 15_000);
        (pingTimer as { unref?: () => void }).unref?.();
      }
    });
    socket.on('error', (error: Error) => frames.push({ at: this.deps.now(), raw: '', message: { type: '(socket-error)', error: error.message } }));
    await this.deps.sleep(durationMs);
    if (pingTimer) clearInterval(pingTimer);
    socket.close();
    return frames;
  }

  // ----- Checks -----

  async q1(): Promise<CheckResult> {
    const title = 'Trade channel payload (trade/{id}, trade_fe/{id})';
    const primary = await this.marketId(this.options.market);
    const secondSymbol = this.options.market === 'ETH' ? 'BTC' : 'ETH';
    const secondary = await this.marketId(secondSymbol).catch(() => primary);
    const channels = [`trade/${primary}`, `trade_fe/${secondary}`, 'market_stats/all'];
    this.deps.log(`  Q1: capturing ${channels.join(', ')} on ${this.profile.label} for ${Math.round(this.options.durationMs / 1000)} s...`);
    this.capture = await this.captureStream(channels, this.options.durationMs);
    const report = analyzeTradeCapture(this.capture);
    const findings = [
      `${report.frames} frames (${report.nullFrames} null); message types: ${JSON.stringify(report.types)}`,
      `acks: ${report.ackTypes.join(', ') || 'none'}; channel separator(s) in replies: ${report.channelSeparators.join(' ') || 'n/a'}`,
      `top-level keys: ${JSON.stringify(report.topLevelKeys)}`,
      `snapshot rows: ${JSON.stringify(report.snapshotRows)}`,
      `trade types: ${JSON.stringify(report.tradeTypes)}; liquidation rows in updates: ${report.liquidationRows}; ` +
        `ids in both trades and liquidation_trades: ${report.duplicatedAcrossArrays}`,
      `server ping intervals (ms): ${report.serverPingIntervalsMs.slice(0, 10).join(', ') || 'none seen'}`,
    ];
    if (report.errors.length > 0) findings.push(`error frames: ${report.errors.slice(0, 3).join(' | ')}`);
    const tradeAcked = report.ackTypes.some(type => type === 'subscribed/trade');
    const feAcked = report.ackTypes.some(type => type === 'subscribed/trade_fe');
    if (!tradeAcked) findings.push('trade/{id} was not acknowledged: the bot falls back to trade_fe/{id} after 10 s');
    return {
      id: 'Q1',
      title,
      status: report.frames === 0 || (!tradeAcked && !feAcked) ? 'warn' : 'info',
      findings,
      data: report,
    };
  }

  async q2(): Promise<CheckResult> {
    const title = 'Liquidated account = taker? /trades?type=liquidation without auth';
    const system = await this.systemAccounts();
    const findings: string[] = [`system accounts (account 1, liquidity pool): ${system.join(', ')}`];
    const { status, body } = await this.getJson(this.profile, '/api/v1/trades', {
      sort_by: 'trade_id', type: 'liquidation', market_type: 'perp', limit: 100,
    });
    let warn = false;
    let rowsReport: LiquidationRowsReport | null = null;
    if (status === 200 && isRecord(body) && Array.isArray(body.trades)) {
      rowsReport = analyzeLiquidationRows(body.trades, system);
      findings.push(
        `/trades?type=liquidation works without auth: ${rowsReport.rows} liquidation rows`,
        `is_maker_ask true/false: ${rowsReport.isMakerAsk.true}/${rowsReport.isMakerAsk.false}; ` +
          `taker_position_sign_changed: ${rowsReport.signChanged}; signed taker_position_size_before seen: ${rowsReport.signedSizeBefore}`,
        `taker is a system account: ${rowsReport.takerIsSystemAccount}; counterparty is a system account: ${rowsReport.makerIsSystemAccount}`,
        `sample (taker rule): ${JSON.stringify(rowsReport.sampleTakerSide)}`
      );
      if (rowsReport.signChanged > 0) {
        findings.push('some liquidations flipped the taker position: check the taker rule against these rows');
        warn = true;
      }
    } else {
      findings.push(`/trades?type=liquidation answered HTTP ${status} without auth (${JSON.stringify(body).slice(0, 160)})`);
    }
    if (this.capture) {
      const bbo = checkLiquidationsAgainstBbo(this.capture);
      findings.push(`BBO cross-check over the Q1 capture: consistent ${bbo.consistent}, inconsistent ${bbo.inconsistent}, no BBO ${bbo.noBbo}`);
      if (bbo.inconsistent > 0) warn = true;
    } else {
      findings.push('BBO cross-check needs the Q1 capture (run Q1 too)');
    }
    return { id: 'Q2', title, status: warn ? 'warn' : 'info', findings, data: rowsReport };
  }

  async q3(): Promise<CheckResult> {
    const title = 'Units of Trade.timestamp / transaction_time (and order times)';
    const marketId = await this.marketId(this.options.market);
    const { status, body } = await this.getJson(this.profile, '/api/v1/recentTrades', { market_id: marketId, limit: 5 });
    const now = this.deps.now();
    const findings: string[] = [];
    let warn = false;
    if (status !== 200 || !isRecord(body) || !Array.isArray(body.trades) || body.trades.length === 0) {
      return { id: 'Q3', title, status: 'error', findings: [`recentTrades answered HTTP ${status} without trades`] };
    }
    for (const field of ['timestamp', 'transaction_time']) {
      const unit = inferTimestampUnit(body.trades[0][field]);
      if (!unit) {
        findings.push(`${field}: missing`);
        continue;
      }
      const skewS = Math.round((unit.ms - now) / 1000);
      findings.push(`${field}: ${String(body.trades[0][field])} -> unit ${unit.unit}, ${skewS} s from the local clock`);
      if (field === 'timestamp' && (unit.unit !== 'ms' || Math.abs(skewS) > 300)) warn = true;
    }
    const headers = this.privateHeaders();
    if (headers) {
      const orders = await this.getJson(this.profile, '/api/v1/accountActiveOrders', { account_index: this.options.accountIndex, market_id: 255 }, headers);
      const list = isRecord(orders.body) && Array.isArray(orders.body.orders) ? orders.body.orders.filter(isRecord) : [];
      if (orders.status !== 200) findings.push(`accountActiveOrders answered HTTP ${orders.status}`);
      else if (list.length === 0) findings.push('accountActiveOrders: no open orders to read times from');
      for (const field of ['created_at', 'updated_at', 'trigger_time']) {
        const value = list.find(order => order[field] !== undefined && order[field] !== 0)?.[field];
        if (value !== undefined) findings.push(`Order.${field}: ${String(value)} -> unit ${inferTimestampUnit(value)?.unit ?? '?'}`);
      }
    } else {
      findings.push('order times skipped (set LIGHTER_AUTH_TOKEN and --account to read your own orders)');
    }
    return { id: 'Q3', title, status: warn ? 'warn' : 'ok', findings };
  }

  async q5(): Promise<CheckResult> {
    const title = 'WebSocket limits (subscriptions per connection, connections per IP)';
    const details = await this.orderBookDetails(this.profile);
    const active = details.filter(m => isRecord(m) && m.status === 'active').map(m => (m as Record<string, any>).market_id as number);
    const channels = active.map(id => `trade/${id}`);
    this.deps.log(`  Q5: subscribing ${channels.length} trade channels on one socket...`);
    const frames = await this.captureStream(channels, Math.min(20_000, Math.max(5_000, this.options.durationMs / 3)));
    const acked = new Set<string>();
    let errors = 0;
    for (const frame of frames) {
      if (!isRecord(frame.message)) continue;
      if (typeof frame.message.type === 'string' && frame.message.type.startsWith('subscribed/trade')) {
        acked.add(String(frame.message.channel));
      }
      if (frame.message.error) errors++;
    }
    const findings = [`${acked.size}/${channels.length} trade subscriptions acknowledged on one socket; ${errors} error frames`];

    // Extra connections, opened one after another and held until the end
    const sockets: LiveSocket[] = [];
    let refusedAt: number | null = null;
    for (let i = 1; i <= this.options.maxSockets; i++) {
      const socket = this.deps.createSocket(lighterStreamUrl(this.profile));
      sockets.push(socket);
      let connected = false;
      let failed = false;
      socket.on('message', (data: Buffer | string) => {
        const message = parseJson(data.toString());
        if (isRecord(message) && message.type === 'connected') connected = true;
      });
      socket.on('error', () => {
        failed = true;
      });
      socket.on('close', () => {
        if (!connected) failed = true;
      });
      await this.deps.sleep(3_000);
      if (!connected || failed) {
        refusedAt = i;
        break;
      }
    }
    for (const socket of sockets) socket.close();
    findings.push(refusedAt === null
      ? `${this.options.maxSockets} parallel connections accepted (raise --max-sockets to probe further)`
      : `connection ${refusedAt} was refused or got no 'connected' frame within 3 s`);
    return {
      id: 'Q5',
      title,
      status: acked.size < channels.length || refusedAt !== null ? 'warn' : 'info',
      findings,
      data: { subscriptions: channels.length, acked: acked.size, errors, refusedAt },
    };
  }

  async q6(): Promise<CheckResult> {
    const title = 'Market invariants per network (sd+pd=6, multiplier 1) and market id differences';
    const profiles = this.options.compareProfiles ? LIGHTER_PROFILE_NAMES.map(name => PROFILES[name]) : [this.profile];
    const findings: string[] = [];
    let warn = false;
    let error = false;
    const loaded = new Map<LighterProfileName, unknown[]>();
    for (const profile of profiles) {
      try {
        const details = await this.orderBookDetails(profile);
        loaded.set(profile.name, details);
        const { checked, violations } = checkMarketInvariants(details);
        findings.push(`${profile.label}: ${checked} perps, ${violations.length} break the invariants`);
        for (const violation of violations.slice(0, 10)) {
          findings.push(`  ${violation.symbol} (market ${String(violation.marketId)}): ${violation.problems.join(', ')}`);
        }
        if (violations.length > 0) warn = true;
      } catch (err) {
        findings.push(`${profile.label}: ${err instanceof Error ? err.message : String(err)}`);
        error = true;
      }
    }
    const base = loaded.get(this.profile.name);
    for (const [name, details] of loaded) {
      if (name === this.profile.name || !base) continue;
      const diff = diffMarketIds(base, details);
      findings.push(`${this.profile.name} vs ${name}: ${diff.differentIds.length} symbols with different ids` +
        `${diff.differentIds.length ? ` (e.g. ${diff.differentIds.slice(0, 5).join(', ')})` : ''}; ` +
        `only on ${this.profile.name}: ${diff.onlyA.length}; only on ${name}: ${diff.onlyB.length}`);
    }
    return { id: 'Q6', title, status: error ? 'error' : warn ? 'warn' : 'ok', findings };
  }

  async q7(): Promise<CheckResult> {
    const title = 'Candle timestamp units, order and empty candles';
    const marketId = await this.marketId(this.options.market);
    const end = this.deps.now();
    const start = end - 60 * 60 * 1000;
    const inMs = await this.getJson(this.profile, '/api/v1/candles', {
      market_id: marketId, resolution: '5m', start_timestamp: start, end_timestamp: end, count_back: 12,
    });
    const inSeconds = await this.getJson(this.profile, '/api/v1/candles', {
      market_id: marketId, resolution: '5m', start_timestamp: Math.floor(start / 1000), end_timestamp: Math.floor(end / 1000), count_back: 12,
    });
    const ms = analyzeCandles(inMs.body);
    const seconds = analyzeCandles(inSeconds.body);
    const findings = [
      `request in ms: HTTP ${inMs.status}, ${ms.count} candles, t unit ${ms.unit ?? 'n/a'}, ascending ${ms.ascending}, without v ${ms.missingVolume}`,
      `request in s: HTTP ${inSeconds.status}, ${seconds.count} candles, t unit ${seconds.unit ?? 'n/a'}`,
    ];
    // The bot requests candles in ms (spec §3.5)
    const ok = inMs.status === 200 && ms.count > 0 && ms.unit === 'ms' && ms.ascending;
    if (!ok) findings.push('the bot requests ms timestamps and expects ascending ms candles: check getKlines');
    return { id: 'Q7', title, status: ok ? 'ok' : 'warn', findings, data: { ms, seconds } };
  }

  async q17(): Promise<CheckResult> {
    const title = 'Does GET / network_id equal the signer chain id?';
    const profiles = this.options.compareProfiles ? LIGHTER_PROFILE_NAMES.map(name => PROFILES[name]) : [this.profile];
    const findings: string[] = [];
    let warn = false;
    let error = false;
    for (const profile of profiles) {
      try {
        const { status, body } = await this.getJson(profile, '/');
        const networkId = isRecord(body) ? body.network_id : undefined;
        findings.push(`${profile.label}: HTTP ${status}, network_id ${String(networkId)}, chain id ${profile.chainId}`);
        if (networkId !== profile.chainId) warn = true;
      } catch (err) {
        findings.push(`${profile.label}: ${err instanceof Error ? err.message : String(err)}`);
        error = true;
      }
    }
    if (warn) findings.push('network_id differs from the chain id somewhere: the bot only logs this (it does not gate on it)');
    return { id: 'Q17', title, status: error ? 'error' : warn ? 'warn' : 'ok', findings };
  }

  async q18(): Promise<CheckResult> {
    const title = 'Robinhood collateral and markets (gated profile)';
    const robinhood = PROFILES.robinhood;
    const findings: string[] = [];
    const assets = await this.getJson(robinhood, '/api/v1/assetDetails');
    const list = isRecord(assets.body) && Array.isArray(assets.body.asset_details) ? assets.body.asset_details.filter(isRecord) : [];
    findings.push(`assetDetails: HTTP ${assets.status}, ${list.length} assets: ${list.map(a => `${String(a.asset_id)}=${String(a.symbol)}`).join(', ')}`);
    const usdc = list.find(a => a.asset_id === 3);
    findings.push(usdc ? `asset 3 is ${String(usdc.symbol)}` : 'no asset with id 3 (USDC on Lighter)');
    let perps = 0;
    try {
      perps = (await this.orderBookDetails(robinhood)).length;
      findings.push(`orderBookDetails: ${perps} perps`);
    } catch (err) {
      findings.push(`orderBookDetails: ${err instanceof Error ? err.message : String(err)}`);
    }
    findings.push('Robinhood stays gated in the bot until these results are reviewed (spec §1.1, §9 Q6/Q17/Q18)');
    return { id: 'Q18', title, status: assets.status === 200 ? 'info' : 'error', findings };
  }

  async q19(): Promise<CheckResult> {
    const title = 'order_index magnitude; do ids arrive as JSON numbers above 2^53?';
    const marketId = await this.marketId(this.options.market);
    const book = await this.getJson(this.profile, '/api/v1/orderBookOrders', { market_id: marketId, limit: 20 });
    const report = analyzeOrderIndexes(book.text);
    const findings = [
      `orderBookOrders: ${report.orders} orders, order_index up to ${report.maxDigits} digits, ${report.aboveTwoPow53} above 2^53 as JSON numbers`,
      `order_id string equals order_index: ${report.orderIdMatches}/${report.orders} (missing order_id: ${report.orderIdMissing})`,
    ];
    const headers = this.privateHeaders();
    if (headers) {
      const own = await this.getJson(this.profile, '/api/v1/accountActiveOrders', { account_index: this.options.accountIndex, market_id: 255 }, headers);
      const ownReport = analyzeOrderIndexes(own.text);
      findings.push(`your open orders: HTTP ${own.status}, ${ownReport.orders} orders, up to ${ownReport.maxDigits} digits, ` +
        `${ownReport.aboveTwoPow53} above 2^53, order_id matches ${ownReport.orderIdMatches}`);
    } else {
      findings.push('own orders skipped (set LIGHTER_AUTH_TOKEN and --account)');
    }
    // The bot reads order_id strings, never the rounded order_index number
    const ok = report.orders === 0 || (report.orderIdMissing === 0 && report.orderIdMatches === report.orders);
    return { id: 'Q19', title, status: book.status !== 200 ? 'error' : ok ? 'ok' : 'warn', findings, data: report };
  }

  async q23(): Promise<CheckResult> {
    const title = 'Official cross-venue symbol map (funding-rates)';
    const { status, body } = await this.getJson(this.profile, '/api/v1/funding-rates');
    const report = analyzeFundingRates(body, ['1000NOT', '1000PEPE', '1000BONK', 'QNT', 'BB']);
    const findings = [
      `HTTP ${status}; rows per exchange: ${JSON.stringify(report.exchanges)}`,
      ...Object.entries(report.pairs).map(([symbol, pairs]) => `${symbol}: ${pairs.join(', ') || 'no rows'}`),
      'If rows pair Lighter markets with Binance symbols, review the bot\'s override list (venues.lighter.symbolOverrides)',
    ];
    return { id: 'Q23', title, status: status === 200 ? 'info' : 'error', findings, data: report };
  }
}

export async function runLiveChecks(options: LiveCheckOptions, deps: LiveCheckDeps): Promise<CheckResult[]> {
  const checker = new Checker(options, deps);
  const results: CheckResult[] = [];
  for (const id of LIVE_CHECK_IDS) {
    if (!options.checks.has(id)) continue;
    const run = (checker as unknown as Record<string, () => Promise<CheckResult>>)[id.toLowerCase()].bind(checker);
    try {
      results.push(await run());
    } catch (error) {
      results.push({ id, title: id, status: 'error', findings: [error instanceof Error ? error.message : String(error)] });
    }
  }
  return results;
}

export function formatReport(profile: LighterProfile, results: CheckResult[]): string {
  const lines = [`Lighter live checks - ${profile.label} (${profile.apiUrl}, chain ${profile.chainId})`, ''];
  for (const result of results) {
    lines.push(`[${result.status.toUpperCase()}] ${result.id} ${result.title}`);
    for (const finding of result.findings) lines.push(`    ${finding}`);
    lines.push('');
  }
  const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  lines.push(`Summary: ${Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ') || 'no checks run'}`);
  return lines.join('\n');
}

// ===== CLI =====

export function parseArgs(argv: string[]): { options: LiveCheckOptions; jsonPath?: string } | { error: string } {
  const options: LiveCheckOptions = {
    profile: 'mainnet',
    checks: new Set(LIVE_CHECK_IDS),
    durationMs: 120_000,
    market: 'BTC',
    maxSockets: 5,
    compareProfiles: false,
  };
  let jsonPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      switch (arg) {
        case '--profile': {
          const name = value();
          if (!isLighterProfileName(name)) return { error: `unknown profile ${name} (${LIGHTER_PROFILE_NAMES.join(', ')})` };
          options.profile = name;
          break;
        }
        case '--checks': {
          const ids = value().split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
          const unknown = ids.filter(id => !(LIVE_CHECK_IDS as readonly string[]).includes(id));
          if (unknown.length > 0) return { error: `unknown check(s) ${unknown.join(', ')} (${LIVE_CHECK_IDS.join(', ')})` };
          options.checks = new Set(ids as LiveCheckId[]);
          break;
        }
        case '--duration': {
          const seconds = Number(value());
          if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) return { error: '--duration must be 5..3600 seconds' };
          options.durationMs = seconds * 1000;
          break;
        }
        case '--market':
          options.market = value().toUpperCase();
          break;
        case '--max-sockets': {
          const count = Number(value());
          if (!Number.isInteger(count) || count < 1 || count > 50) return { error: '--max-sockets must be 1..50' };
          options.maxSockets = count;
          break;
        }
        case '--account': {
          const account = Number(value());
          if (!Number.isSafeInteger(account) || account < 1) return { error: '--account must be a positive integer' };
          options.accountIndex = account;
          break;
        }
        case '--compare-profiles':
          options.compareProfiles = true;
          break;
        case '--json':
          jsonPath = value();
          break;
        case '--help':
        case '-h':
          return { error: 'help' };
        default:
          return { error: `unknown argument ${arg}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { options, jsonPath };
}

const USAGE = `Usage: npm run lighter:check -- [--profile mainnet] [--checks ${LIVE_CHECK_IDS.join(',')}] [--duration 120]
       [--market BTC] [--max-sockets 5] [--compare-profiles] [--account <index>] [--json <file>]
Read-only: no signing, no orders. Set LIGHTER_AUTH_TOKEN (with --account) to include your own orders in Q3/Q19.`;

const nodeDeps: LiveCheckDeps = {
  httpGet: async (url, headers) => {
    const response = await axios.get(url, {
      headers,
      timeout: 15_000,
      responseType: 'text',
      transformResponse: [(raw: unknown) => raw],
      validateStatus: () => true,
    });
    return { status: response.status, text: typeof response.data === 'string' ? response.data : String(response.data ?? '') };
  },
  createSocket: (url) => new WebSocket(url) as unknown as LiveSocket,
  now: () => Date.now(),
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
};

export async function main(argv: string[], deps: LiveCheckDeps = nodeDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    if (parsed.error !== 'help') console.error(`lighter:check: ${parsed.error}`);
    console.error(USAGE);
    return parsed.error === 'help' ? 0 : 2;
  }
  const { options, jsonPath } = parsed;
  const token = process.env.LIGHTER_AUTH_TOKEN?.trim();
  if (token) options.authToken = token;
  const profile = PROFILES[options.profile];
  deps.log(`Lighter live checks on ${profile.label}: ${[...options.checks].join(', ')} (read-only)`);
  const results = await runLiveChecks(options, deps);
  deps.log('');
  deps.log(formatReport(profile, results));
  if (jsonPath) {
    await fs.writeFile(jsonPath, JSON.stringify({ profile: profile.name, at: new Date(deps.now()).toISOString(), results }, null, 2));
    deps.log(`\nWrote ${jsonPath}`);
  }
  return results.some(r => r.status === 'warn' || r.status === 'error') ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      console.error('lighter:check failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  );
}
