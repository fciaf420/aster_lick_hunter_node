import type { VenueCapabilities } from '../types';

// What the Lighter venue supports, in the bot's venue-neutral terms (lighter spec §7)
export const LIGHTER_CAPABILITIES: VenueCapabilities = Object.freeze({
  hedgeMode: false,          // One netted position per market (AccountPosition sign + position; no position side)
  setPositionMode: false,    // No API to switch position mode
  reduceOnly: true,          // ReduceOnly 0|1
  postOnly: true,            // TimeInForce 2 = POST_ONLY
  maxBatchOrders: 20,        // Server max 50 txs per sendTxBatch (error 21514); the FE caps the standard tier at 20
  stopMarket: true,          // Type 2 STOP_LOSS (IOC + trigger + worst price + expiry)
  takeProfitMarket: true,    // Type 4 TAKE_PROFIT
  triggerPrice: 'MARK',      // Inferred (strong): trigger_status 'mark-price'; the FE validates triggers against mark
  perSymbolLeverage: true,   // UpdateLeverage per market (tx 20)
  marginAsset: 'USDC',       // Asset id 3, 6 decimals. Never alias it as USDT.
}) as VenueCapabilities;

// Venue facts the bot will need but VenueCapabilities doesn't carry yet (spec §7)
export const LIGHTER_VENUE_METADATA = Object.freeze({
  // Bot order ids are client order indexes (numbers below 2^48). Orders placed outside the bot have no client
  // order index; they are identified by the exchange order_index, which can exceed 2^53 and is then a string.
  orderIdIsString: true,
  maxGroupedOrders: 3,       // OTO / OCO / OTOCO, same market
  nativeOco: true,           // SL + TP sent as one grouped tx (grouping type 2)
  takerLatencyMs: 300,       // Server-side taker delay on the standard and plus tiers (premium: 140)
  maxTxsPerBatch: 50,        // sendTxBatch limit (error 21514 above)
});
