import {
  MINUTE_MS,
  SINGLE_STRATEGY_ID,
  type DeltaStats,
  type EventSelection,
  type ExclusionReason,
  type Metrics,
  type PairAnalysisResult,
  type StrategyHorizonResult,
} from './pairAnalysis';

// Console report and JSON of a pair analysis, and the advice for candles the database lacks.

const DAY_MS = 24 * 60 * MINUTE_MS;

// The one line to read before anything else in the output
export const PAIR_ANALYSIS_CAVEAT =
  'CAVEAT: in-sample only (no out-of-sample test); backfilled Lighter rows skip the book-side gate, so they are ' +
  'optimistic (docs/LIGHTER-HISTORY.md); funding is ignored; fills are at 1m closes (no spread, depth or latency).';

export const PAIR_ANALYSIS_CAVEAT_NOTES = [
  'Exits are fixed-horizon, not the bot\'s TP/SL.',
  'Overlapping and clustered events are treated as independent, so t-statistics are optimistic.',
  'Pair strategies deploy more gross notional than the single leg: compare mean per unit of exposure and the Sharpe-like ratio, not the raw mean alone.',
];

const REASON_LABELS: Record<ExclusionReason, string> = {
  'horizon-not-elapsed': 'horizon not elapsed',
  'entry-candle-missing': 'entry candle missing',
  'exit-candle-missing': 'exit candle missing',
  'hedge-is-event-symbol': 'event is the hedge symbol',
  'hedge-candle-missing': 'hedge candle missing',
  'partner-candle-missing': 'partner candle missing',
};

export interface PairAnalysisReportContext {
  dbPath: string;
  venue: string;
  candleVenue: string;
  includeSkipped: boolean;
  symbolsFilter?: readonly string[];
  sinceMs?: number;
  untilMs?: number;
  minUsd: number;
  dedupeSec: number;
  selection: Pick<EventSelection, 'rows' | 'invalid' | 'belowMinUsd' | 'collapsed'>;
  candlesLoaded: Record<string, number>;
  notes: readonly string[];
  now: number;
  symbolRowLimit?: number;                          // Rows of the per-symbol tables (default 25)
}

// ===== Missing candles =====

export interface MissingCandleAdvice {
  symbols: Array<{ symbol: string; reason: string }>;
  days: number;                                     // lighter:backfill --days: back from now to the first candle needed
  command: string | null;                           // null when the candle venue cannot be fetched
  note: string;
}

export function lighterCandleFetchCommand(symbols: readonly string[], days: number): string {
  return `npm run lighter:backfill -- --candles-only --symbols ${symbols.join(',')} --days ${days}`;
}

// Which symbols lack candles for the analysed window and the command that fetches them; null when nothing is missing.
// A symbol counts when an event lost a strategy to one of its candles (not when the horizon had not elapsed yet), when
// the hedge has none at all, or when the hedge had too little data to estimate beta.
export function missingCandleAdvice(
  result: PairAnalysisResult,
  context: Pick<PairAnalysisReportContext, 'candleVenue' | 'candlesLoaded' | 'now'>
): MissingCandleAdvice | null {
  const reasons = new Map<string, string[]>();
  const add = (symbol: string, reason: string): void => {
    reasons.set(symbol, [...(reasons.get(symbol) ?? []), reason]);
  };
  for (const hedge of result.hedges) {
    if ((context.candlesLoaded[hedge.symbol] ?? 0) === 0) add(hedge.symbol, `hedge: no ${context.candleVenue} 1m candles stored for the window`);
    else if (hedge.betaFallbacks > 0) add(hedge.symbol, `hedge: too little data for beta before ${hedge.betaFallbacks} of ${hedge.events} events (beta 1 used)`);
  }
  for (const [symbol, events] of Object.entries(result.gapSymbols)) {
    add(symbol, `a candle is missing at the entry or exit of ${events} event(s)`);
  }
  if (reasons.size === 0 || result.events.firstEventTime === null) return null;

  const symbols = [...reasons.keys()].sort();
  const firstNeeded = result.events.firstEventTime - (result.options.betaLookbackMin + 3) * MINUTE_MS;
  const days = Math.max(0.1, Math.ceil(((context.now - firstNeeded) / DAY_MS) * 10) / 10);
  const lighter = context.candleVenue === 'lighter';
  const command = lighterCandleFetchCommand(symbols, days);
  return {
    symbols: symbols.map(symbol => ({ symbol, reason: reasons.get(symbol)!.join('; ') })),
    days,
    command: lighter ? command : null,
    note: lighter
      ? 'Add --profile mainnet if the liquidations came from mainnet. The symbols need not be in the config. Some gaps are real ' +
        '(a minute without trades may have no candle) and stay after fetching. Candles older than global.liquidationRetentionDays ' +
        'are deleted again by the bot\'s daily cleanup.'
      : `No script stores ${context.candleVenue} candles in the database. To price these events with Lighter's candles (a proxy ` +
        `for ${context.candleVenue}'s prices), fetch them with ${command} and run again with --candle-venue lighter.`,
  };
}

// ===== Formatting =====

function num(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(digits);
}

function signed(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function pct(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(0)}%`;
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => row[column].length)));
  const line = (cells: string[]): string => cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ');
  return [line(headers), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)];
}

function iso(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

function cell(metrics: Metrics | undefined): string {
  return metrics && metrics.n > 0 ? `${signed(metrics.meanBps)} [${metrics.n}]` : '-';
}

function metricsRow(label: string, result: StrategyHorizonResult): string[] {
  const m = result.metrics;
  return [
    label, String(m.n), signed(m.meanBps), signed(m.medianBps), num(m.stdevBps), pct(m.winRate), signed(m.tStat, 2), signed(m.sharpe, 3),
    signed(m.p5Bps), num(m.maxDrawdownBps), num(m.meanExposure, 2), signed(m.meanPerExposureBps), String(result.excludedTotal),
  ];
}

function deltaRow(label: string, stats: DeltaStats): string[] {
  return [label, String(stats.n), signed(stats.meanBps), num(stats.stdevBps), signed(stats.tStat, 2), pct(stats.winRate)];
}

export function formatPairAnalysisReport(result: PairAnalysisResult, context: PairAnalysisReportContext): string {
  const out: string[] = [];
  const labelOf = new Map(result.strategies.map(strategy => [strategy.id, strategy.label]));
  const label = (id: string): string => labelOf.get(id) ?? id;
  const options = result.options;
  const { selection } = context;

  out.push(`Pair analysis of ${context.venue} liquidation signals (1m candles: ${context.candleVenue})`);
  out.push(`Database: ${context.dbPath}`);
  out.push(PAIR_ANALYSIS_CAVEAT);
  for (const note of PAIR_ANALYSIS_CAVEAT_NOTES) out.push(`Also: ${note}`);
  out.push('');

  for (const note of context.notes) out.push(`Note: ${note}`);
  const scope = context.includeSkipped
    ? 'all detections, including the ones the feed did not trade'
    : "tradable rows (skip_reason empty or 'shadow mode', the Lighter optimizer's scope)";
  const period = [
    context.sinceMs !== undefined ? `from ${iso(context.sinceMs)}` : null,
    context.untilMs !== undefined ? `before ${iso(context.untilMs)}` : null,
  ].filter(Boolean).join(' ');
  out.push(
    `Scope: ${scope}; symbols ${context.symbolsFilter && context.symbolsFilter.length > 0 ? context.symbolsFilter.join(', ') : 'all'}; ` +
    `min size ${context.minUsd} USD${period ? `; events ${period}` : ''}`
  );
  const symbolCount = Object.keys(result.events.bySymbol).length;
  out.push(
    `Events: ${selection.rows} rows -> ${result.events.total} events on ${symbolCount} symbol(s) ` +
    `(${selection.collapsed} collapsed within ${context.dedupeSec}s of the same symbol and side, ${selection.belowMinUsd} below the minimum size` +
    `${selection.invalid > 0 ? `, ${selection.invalid} unusable` : ''}); ` +
    `long liquidations (bot buys): ${result.events.long}, short liquidations (bot sells): ${result.events.short}`
  );
  if (result.events.total > 0) {
    out.push(`Window: ${iso(result.events.firstEventTime)} -> ${iso(result.events.lastEventTime)}`);
    out.push(
      result.events.backfilled > 0
        ? `Book check: not applied to ${result.events.backfilled} of ${result.events.total} events (backfilled: they pass the non-book gates only, so results lean optimistic)`
        : `Book check: applied to all ${result.events.total} events (none are backfilled)`
    );
  }
  out.push(
    `Costs: ${options.feeBps} bps fee + ${options.slippageBps} bps slippage per leg and side, paid on every leg ` +
    `(${(2 * (options.feeBps + options.slippageBps)).toFixed(1)} bps round trip per unit of leg notional)`
  );
  for (const hedge of result.hedges) {
    out.push(
      options.hedgeSizing === 'dollar'
        ? `Hedge ${hedge.symbol}: equal notional (beta 1), ${hedge.events} events`
        : `Hedge ${hedge.symbol}: beta over ${options.betaLookbackMin} min of 1m log returns, clamped to [0, 3]; ${hedge.events} events, ` +
          `${hedge.betaFallbacks} fell back to beta 1 (fewer than ${options.betaMinObservations} paired returns), ${hedge.betaClamped} clamped, ` +
          `mean beta ${num(hedge.meanBeta, 2)}, median ${num(hedge.medianBeta, 2)}`
    );
  }
  out.push(
    `Cross-pair: opposite-direction signal on another symbol within ${options.pairWindowSec}s; ${result.events.withPartner} of ${result.events.total} events had a partner, ` +
    `${result.events.pairs} pair${result.events.pairs === 1 ? '' : 's'} formed (an event joins at most one pair, entered when the later signal arrives)`
  );

  if (result.events.total === 0) {
    out.push('');
    out.push('No events to analyse.');
    return out.join('\n');
  }

  for (const horizon of result.horizons) {
    out.push('');
    out.push(`=== Horizon ${horizon.horizonMin} min ===`);
    out.push('Net return per trade in bps of the liquidated leg\'s notional, after costs. expo: gross notional per unit of that notional.');
    out.push(...renderTable(
      ['strategy', 'n', 'mean', 'median', 'stdev', 'win%', 't', 'sharpe', 'p5', 'maxDD', 'expo', 'mean/expo', 'excl'],
      horizon.strategies.map(item => metricsRow(label(item.strategy), item))
    ));
    for (const strategy of horizon.strategies) {
      const reasons = Object.entries(strategy.excluded) as Array<[ExclusionReason, number]>;
      if (reasons.length > 0) {
        out.push(`  excluded from ${label(strategy.strategy)}: ${reasons.map(([reason, count]) => `${REASON_LABELS[reason]} ${count}`).join(', ')}`);
      }
    }

    out.push('');
    out.push('Pair minus single, same events (bps of the liquidated leg\'s notional: what the extra leg adds, costs included; paired t)');
    out.push(...renderTable(
      ['strategy minus single', 'n', 'mean', 'stdev', 't', 'win%'],
      horizon.deltas.map(delta => deltaRow(label(delta.strategy), delta.stats))
    ));

    const others = horizon.strategies.filter(strategy => strategy.strategy !== SINGLE_STRATEGY_ID);
    const symbols = Object.keys(horizon.strategies.find(strategy => strategy.strategy === SINGLE_STRATEGY_ID)?.bySymbol ?? {})
      .sort((a, b) => (result.events.bySymbol[b] ?? 0) - (result.events.bySymbol[a] ?? 0) || a.localeCompare(b));
    // A symbol with trades only in a pair strategy still shows
    for (const strategy of others) for (const symbol of Object.keys(strategy.bySymbol)) if (!symbols.includes(symbol)) symbols.push(symbol);
    const limit = context.symbolRowLimit ?? 25;
    const single = horizon.strategies.find(strategy => strategy.strategy === SINGLE_STRATEGY_ID);
    if (symbols.length === 0) continue;
    out.push('');
    out.push('Per symbol: mean net bps [n] (cross-pair by triggering symbol); delta columns: mean difference to single');
    out.push(...renderTable(
      ['symbol', 'single', ...others.map(strategy => label(strategy.strategy)), ...others.map(strategy => `d ${label(strategy.strategy)}`)],
      symbols.slice(0, limit).map(symbol => [
        symbol,
        cell(single?.bySymbol[symbol]),
        ...others.map(strategy => cell(strategy.bySymbol[symbol])),
        ...others.map(strategy => {
          const delta = horizon.deltas.find(item => item.strategy === strategy.strategy)?.bySymbol[symbol];
          return delta && delta.n > 0 ? signed(delta.meanBps) : '-';
        }),
      ])
    ));
    if (symbols.length > limit) out.push(`  ... ${symbols.length - limit} more symbol(s); all of them are in the --json output`);
  }

  const advice = missingCandleAdvice(result, context);
  if (advice) {
    out.push('');
    out.push('Missing candles');
    for (const item of advice.symbols) out.push(`  ${item.symbol}: ${item.reason}`);
    if (advice.command) {
      out.push('  Fetch them with:');
      out.push(`    ${advice.command}`);
    }
    out.push(`  ${advice.note}`);
  }
  return out.join('\n');
}

// The full result for --json
export function pairAnalysisJson(
  result: PairAnalysisResult,
  context: PairAnalysisReportContext,
  generatedAt: number
): Record<string, unknown> {
  return {
    generatedAt: new Date(generatedAt).toISOString(),
    database: context.dbPath,
    venue: context.venue,
    candleVenue: context.candleVenue,
    scope: {
      includeSkipped: context.includeSkipped,
      symbols: context.symbolsFilter ?? null,
      since: context.sinceMs !== undefined ? new Date(context.sinceMs).toISOString() : null,
      until: context.untilMs !== undefined ? new Date(context.untilMs).toISOString() : null,
      minUsd: context.minUsd,
      dedupeSec: context.dedupeSec,
      rows: context.selection.rows,
      collapsed: context.selection.collapsed,
      belowMinUsd: context.selection.belowMinUsd,
      unusable: context.selection.invalid,
    },
    caveats: [PAIR_ANALYSIS_CAVEAT, ...PAIR_ANALYSIS_CAVEAT_NOTES],
    notes: context.notes,
    missingCandles: missingCandleAdvice(result, context),
    ...result,
  };
}
