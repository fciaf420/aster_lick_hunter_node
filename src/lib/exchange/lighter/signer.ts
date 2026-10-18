// Lighter (zkLighter) native signer: a koffi binding to the Go c-shared library that ships inside
// elliottech/lighter-python (lighter spec §6). Every Lighter transaction (orders, cancels, leverage)
// and every auth token is signed here.
//
// Safety rules this module enforces:
// - Importing it loads nothing. koffi and the library are loaded on the first loadLighterSigner()
//   call, and never inside Next.js (the Go runtime cannot be unloaded, and a route bundle must not
//   carry a native FFI module).
// - The binary is picked by platform/arch and must match the pinned sha256 (§6.2) before koffi is
//   even required. Install it with `npm run lighter:signer`.
// - The C struct layout is checked (sizeof(CreateOrderTxReq) == 48) before any call.
// - koffi silently wraps out-of-range numbers (4294967396 -> 100, 100.7 -> 100, -1 -> 4294967295),
//   so every argument passes an integer range guard first, and every signed tx must echo the
//   requested values before it is returned.
// - Every char* the library returns is released with the library's own Free().
// - One network per process: the library keeps a process-global chain id that each CreateClient
//   call overwrites (§8 risk 24).
// - Signing is offline. The Go client is created without an HTTP endpoint, so it can never fetch a
//   nonce or reach the network by itself; callers always pass an explicit nonce.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as nodeModule from 'module';
import * as path from 'path';
import type * as Koffi from 'koffi';
import type { OrderId } from '../types';
import { logWithTimestamp } from '../../utils/timestamp';

// ---------------------------------------------------------------------------------------------
// Pinned binaries (§6.2). Keep in sync with scripts/lighter-signer.js; tests check both match.
// ---------------------------------------------------------------------------------------------

export const LIGHTER_SIGNER_COMMIT = '5825eb19867a4dbdd47c02642dc1eec30c30ca73';
export const LIGHTER_SIGNER_BASE_URL =
  `https://raw.githubusercontent.com/elliottech/lighter-python/${LIGHTER_SIGNER_COMMIT}/lighter/signers/`;

export interface LighterSignerBinary {
  file: string;
  sha256: string;
}

// Keyed by `${process.platform}-${process.arch}`. Linux builds need glibc (no musl/Alpine).
export const LIGHTER_SIGNER_BINARIES: Readonly<Record<string, Readonly<LighterSignerBinary>>> = Object.freeze({
  'linux-x64': Object.freeze({ file: 'lighter-signer-linux-amd64.so', sha256: '49c6b61e0e95a4a70f2a252e469c393760c929d61179c340e2932ab62882caf2' }),
  'linux-arm64': Object.freeze({ file: 'lighter-signer-linux-arm64.so', sha256: '3b6fd0b8f4caecbff9ce817dffb11a2321f078e0b4acc9a58623354bb55cc289' }),
  'darwin-arm64': Object.freeze({ file: 'lighter-signer-darwin-arm64.dylib', sha256: 'b8e602542721a11aff4236a247e775150b421c0eb7532442209658a5b0c22f31' }),
  'darwin-x64': Object.freeze({ file: 'lighter-signer-darwin-amd64.dylib', sha256: 'a74e230cebde6c61d35de09587f0980b383b991fa694f974b4070adec6b64bb3' }),
  'win32-x64': Object.freeze({ file: 'lighter-signer-windows-amd64.dll', sha256: '3f6baac6015a27d652971947442c69f26f37cf6bdae7fd74f3c05cd2d8c194b1' }),
});

// Install directory, relative to the project root (the bot's working directory)
export const LIGHTER_SIGNER_DIR = path.join('vendor', 'lighter-signer');
// Optional override of the library file location; the pinned sha256 still applies
export const LIGHTER_SIGNER_PATH_ENV = 'LIGHTER_SIGNER_PATH';

// Chain ids from the profile table (§1.1): mainnet 304, testnet and robinhood_testnet 300, robinhood 466324
export const LIGHTER_KNOWN_CHAIN_IDS: ReadonlyArray<number> = Object.freeze([300, 304, 466324]);

// ---------------------------------------------------------------------------------------------
// Protocol constants (GO types/txtypes/constants.go)
// ---------------------------------------------------------------------------------------------

export const LIGHTER_TX_TYPE = Object.freeze({
  CREATE_ORDER: 14,
  CANCEL_ORDER: 15,
  CANCEL_ALL_ORDERS: 16,
  UPDATE_LEVERAGE: 20,
  CREATE_GROUPED_ORDERS: 28,
} as const);

export const LIGHTER_ORDER_TYPE = Object.freeze({
  LIMIT: 0,
  MARKET: 1,
  STOP_LOSS: 2,
  STOP_LOSS_LIMIT: 3,
  TAKE_PROFIT: 4,
  TAKE_PROFIT_LIMIT: 5,
  TWAP: 6,
} as const);
export type LighterOrderType = typeof LIGHTER_ORDER_TYPE[keyof typeof LIGHTER_ORDER_TYPE];

export const LIGHTER_TIME_IN_FORCE = Object.freeze({ IOC: 0, GTT: 1, POST_ONLY: 2 } as const);
export type LighterTimeInForce = typeof LIGHTER_TIME_IN_FORCE[keyof typeof LIGHTER_TIME_IN_FORCE];

export const LIGHTER_GROUPING_TYPE = Object.freeze({ OTO: 1, OCO: 2, OTOCO: 3 } as const);
export type LighterGroupingType = typeof LIGHTER_GROUPING_TYPE[keyof typeof LIGHTER_GROUPING_TYPE];

export const LIGHTER_CANCEL_ALL_TIME_IN_FORCE = Object.freeze({ IMMEDIATE: 0, SCHEDULED: 1, ABORT: 2 } as const);
export type LighterCancelAllTimeInForce =
  typeof LIGHTER_CANCEL_ALL_TIME_IN_FORCE[keyof typeof LIGHTER_CANCEL_ALL_TIME_IN_FORCE];

export const LIGHTER_MARGIN_MODE = Object.freeze({ CROSS: 0, ISOLATED: 1 } as const);
export type LighterMarginMode = typeof LIGHTER_MARGIN_MODE[keyof typeof LIGHTER_MARGIN_MODE];

// Market index meaning "no market"; for cancel-all it means every market
export const LIGHTER_ALL_MARKETS = 255;

export const LIGHTER_MAX_UINT32 = 0xFFFFFFFF;            // Price, TriggerPrice
export const LIGHTER_MAX_INT48 = 2 ** 48 - 1;            // ClientOrderIndex, BaseAmount, MarketIndex
export const LIGHTER_MAX_ACCOUNT_INDEX = 2 ** 48 - 2;
export const LIGHTER_MAX_API_KEY_INDEX = 254;            // 255 makes the library pick a "default" client
export const LIGHTER_MAX_ORDER_INDEX = BigInt(2) ** BigInt(60) - BigInt(1); // exchange order_index
export const LIGHTER_MAX_INITIAL_MARGIN_FRACTION = 10_000; // 1/10000 ticks; the C side truncates to uint16
export const LIGHTER_MIN_ORDER_EXPIRY_MS = 5 * 60 * 1000;
export const LIGHTER_MAX_ORDER_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const LIGHTER_MIN_CANCEL_ALL_DELAY_MS = 5 * 60 * 1000;
export const LIGHTER_MAX_CANCEL_ALL_DELAY_MS = 15 * 24 * 60 * 60 * 1000;
export const LIGHTER_MAX_AUTH_TOKEN_LIFETIME_SEC = 8 * 60 * 60;

// ---------------------------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------------------------

// One order in integer exchange units (§3.2). Callers scale with exact decimal arithmetic first.
export interface LighterOrderParams {
  marketIndex: number;
  clientOrderIndex: number;  // 1..2^48-1; the bot's order id for this order (§5.6)
  baseAmount: number;        // qty x 10^size_decimals
  price: number;             // price x 10^price_decimals; the worst fill price for MARKET/SL/TP
  isAsk: boolean;            // true = SELL
  type: LighterOrderType;
  timeInForce: LighterTimeInForce;
  reduceOnly: boolean;
  triggerPrice: number;      // 0 = none
  orderExpiry: number;       // ms since epoch, 5 min..30 days ahead; 0 = none (MARKET, IOC). Never -1.
}

export interface LighterCreateOrderRequest extends LighterOrderParams {
  nonce: number;
}

export interface LighterGroupedOrdersRequest {
  groupingType: LighterGroupingType;
  orders: LighterOrderParams[]; // OTO: parent + child, OCO: SL + TP, OTOCO: parent + SL + TP
  nonce: number;
}

export interface LighterCancelOrderRequest {
  marketIndex: number;
  // Client order index (<= 2^48-1) or exchange order_index (2^48..2^60-1). Pass ids above 2^53 as a
  // decimal string or bigint; a JS number cannot hold them exactly.
  index: OrderId | bigint;
  nonce: number;
}

export interface LighterCancelAllRequest {
  timeInForce: LighterCancelAllTimeInForce;
  time: number;          // IMMEDIATE and ABORT: 0. SCHEDULED: absolute ms, 5 min..15 days ahead.
  marketIndex?: number;  // one market (IMMEDIATE only); default LIGHTER_ALL_MARKETS
  nonce: number;
}

export interface LighterUpdateLeverageRequest {
  marketIndex: number;
  initialMarginFraction: number; // 1..10000 ticks: ceil(10000 / leverage)
  marginMode: LighterMarginMode;
  nonce: number;
}

export interface LighterSignedTx {
  txType: number;
  txInfo: string;     // JSON exactly as signed. Send it verbatim: an Index above 2^53 does not survive JSON.parse.
  txHash: string;     // 80 hex chars, no 0x. Known before sending, so it can be persisted first (§5.1).
  nonce: number;
  expiredAt: number;  // ms; the tx is void after this (the library sets now + 10 min - 1 s)
}

export interface LighterSigner {
  readonly chainId: number;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly libraryPath: string;
  readonly librarySha256: string;
  signCreateOrder(request: LighterCreateOrderRequest): LighterSignedTx;
  signGroupedOrders(request: LighterGroupedOrdersRequest): LighterSignedTx;
  signCancelOrder(request: LighterCancelOrderRequest): LighterSignedTx;
  signCancelAll(request: LighterCancelAllRequest): LighterSignedTx;
  signUpdateLeverage(request: LighterUpdateLeverageRequest): LighterSignedTx;
  // Auth token for private REST and WS. deadlineSec: unix seconds, in the future and at most 8 h away.
  // The token is a credential: never log it.
  createAuthToken(deadlineSec: number): string;
}

export interface LoadLighterSignerOptions {
  chainId: number;            // from the profile table, never from a URL
  accountIndex: number;
  apiKeyIndex: number;
  apiKeyPrivateKey: string;   // 40-byte key as hex, with or without 0x
  libraryPath?: string;       // default: $LIGHTER_SIGNER_PATH, else <cwd>/vendor/lighter-signer/<file>
}

export class LighterSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LighterSignerError';
  }
}

// ---------------------------------------------------------------------------------------------
// Guards. koffi passes whatever JS number it gets after silent truncation, so nothing reaches the
// library without passing one of these.
// ---------------------------------------------------------------------------------------------

function describeValue(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export function guardInt(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Lighter signer: ${name} must be an integer in [${min}, ${max}], got ${describeValue(value)}`);
  }
  return value === 0 ? 0 : value; // drop -0
}

export function guardUint32(name: string, value: unknown, allowZero = false): number {
  return guardInt(name, value, allowZero ? 0 : 1, LIGHTER_MAX_UINT32);
}

export function guardInt48(name: string, value: unknown, allowZero = false): number {
  return guardInt(name, value, allowZero ? 0 : 1, LIGHTER_MAX_INT48);
}

function guardFlag(name: string, value: unknown): 0 | 1 {
  if (typeof value !== 'boolean') {
    throw new RangeError(`Lighter signer: ${name} must be a boolean, got ${describeValue(value)}`);
  }
  return value ? 1 : 0;
}

function guardOneOf<T extends number>(name: string, value: unknown, allowed: ReadonlyArray<T>): T {
  if (typeof value !== 'number' || !allowed.includes(value as T)) {
    throw new RangeError(`Lighter signer: ${name} must be one of ${allowed.join(', ')}, got ${describeValue(value)}`);
  }
  return value as T;
}

export function guardMarketIndex(name: string, value: unknown): number {
  const market = guardInt(name, value, 0, LIGHTER_MAX_INT48);
  if (market === LIGHTER_ALL_MARKETS) {
    throw new RangeError(`Lighter signer: ${name} ${LIGHTER_ALL_MARKETS} is the "no market" marker, not a market`);
  }
  return market;
}

export function guardNonce(value: unknown): number {
  // -1 would make the library fetch a nonce itself (§5.1); explicit nonces only
  return guardInt('nonce', value, 0, Number.MAX_SAFE_INTEGER);
}

export function guardOrderExpiry(name: string, value: unknown, nowMs: number = Date.now()): number {
  const expiry = guardInt(name, value, 0, Number.MAX_SAFE_INTEGER);
  if (expiry === 0) return 0;
  const ahead = expiry - nowMs;
  if (ahead < LIGHTER_MIN_ORDER_EXPIRY_MS || ahead > LIGHTER_MAX_ORDER_EXPIRY_MS) {
    throw new RangeError(
      `Lighter signer: ${name} must be 0 or a ms timestamp 5 min to 30 days ahead, got ${expiry} (${ahead} ms ahead)`
    );
  }
  return expiry;
}

// Client order index or exchange order_index, exact (returns a bigint for the int64 argument)
export function guardOrderIndex(value: unknown): bigint {
  let index: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `Lighter signer: order index ${describeValue(value)} is not an exact integer; pass ids above 2^53 as a string`
      );
    }
    index = BigInt(value);
  } else if (typeof value === 'bigint') {
    index = value;
  } else if (typeof value === 'string' && /^[0-9]{1,19}$/.test(value)) {
    index = BigInt(value);
  } else {
    throw new RangeError(`Lighter signer: order index must be an integer, a decimal string or a bigint, got ${describeValue(value)}`);
  }
  if (index < BigInt(1) || index > LIGHTER_MAX_ORDER_INDEX) {
    throw new RangeError(`Lighter signer: order index must be in [1, ${LIGHTER_MAX_ORDER_INDEX}], got ${index}`);
  }
  return index;
}

// Field order and names of the C struct CreateOrderTxReq
export interface LighterNativeOrder {
  MarketIndex: number;
  ClientOrderIndex: number;
  BaseAmount: number;
  Price: number;
  IsAsk: 0 | 1;
  Type: number;
  TimeInForce: number;
  ReduceOnly: 0 | 1;
  TriggerPrice: number;
  OrderExpiry: number;
}

const ORDER_TYPES: ReadonlyArray<number> = Object.values(LIGHTER_ORDER_TYPE);
const TIME_IN_FORCE_VALUES: ReadonlyArray<number> = Object.values(LIGHTER_TIME_IN_FORCE);
const GROUPING_TYPES: ReadonlyArray<LighterGroupingType> = Object.values(LIGHTER_GROUPING_TYPE);
const CANCEL_ALL_TIF_VALUES: ReadonlyArray<LighterCancelAllTimeInForce> = Object.values(LIGHTER_CANCEL_ALL_TIME_IN_FORCE);
const MARGIN_MODES: ReadonlyArray<LighterMarginMode> = Object.values(LIGHTER_MARGIN_MODE);

// Range-check one order and convert it to the native field layout. A zero base amount (an order
// tied to the whole position) is refused unless allowZeroBaseAmount is set, which only the
// children of OTO/OTOCO groups need (§8 risk 14).
export function normalizeLighterOrder(
  order: LighterOrderParams,
  options: { label?: string; allowZeroBaseAmount?: boolean; nowMs?: number } = {}
): LighterNativeOrder {
  const label = options.label ?? 'order';
  if (!order || typeof order !== 'object') {
    throw new RangeError(`Lighter signer: ${label} must be an object`);
  }
  const reduceOnly = guardFlag(`${label}.reduceOnly`, order.reduceOnly);
  const baseAmount = guardInt48(`${label}.baseAmount`, order.baseAmount, options.allowZeroBaseAmount === true);
  if (baseAmount === 0 && reduceOnly !== 1) {
    throw new RangeError(`Lighter signer: ${label}.baseAmount 0 is only valid on a reduce-only child order`);
  }
  return {
    MarketIndex: guardMarketIndex(`${label}.marketIndex`, order.marketIndex),
    ClientOrderIndex: guardInt48(`${label}.clientOrderIndex`, order.clientOrderIndex),
    BaseAmount: baseAmount,
    Price: guardUint32(`${label}.price`, order.price),
    IsAsk: guardFlag(`${label}.isAsk`, order.isAsk),
    Type: guardOneOf(`${label}.type`, order.type, ORDER_TYPES),
    TimeInForce: guardOneOf(`${label}.timeInForce`, order.timeInForce, TIME_IN_FORCE_VALUES),
    ReduceOnly: reduceOnly,
    TriggerPrice: guardUint32(`${label}.triggerPrice`, order.triggerPrice, true),
    OrderExpiry: guardOrderExpiry(`${label}.orderExpiry`, order.orderExpiry, options.nowMs),
  };
}

function guardGroupedOrders(request: LighterGroupedOrdersRequest, nowMs: number): {
  groupingType: LighterGroupingType;
  orders: LighterNativeOrder[];
} {
  const groupingType = guardOneOf('groupingType', request.groupingType, GROUPING_TYPES);
  const expectedCount = groupingType === LIGHTER_GROUPING_TYPE.OTOCO ? 3 : 2;
  if (!Array.isArray(request.orders) || request.orders.length !== expectedCount) {
    throw new RangeError(
      `Lighter signer: grouping type ${groupingType} needs exactly ${expectedCount} orders, got ${
        Array.isArray(request.orders) ? request.orders.length : describeValue(request.orders)
      }`
    );
  }
  // OCO legs carry an explicit size (never position-tied); OTO/OTOCO children must be size 0
  const childrenArePositionTied = groupingType !== LIGHTER_GROUPING_TYPE.OCO;
  const orders = request.orders.map((order, i) =>
    normalizeLighterOrder(order, {
      label: `orders[${i}]`,
      allowZeroBaseAmount: childrenArePositionTied && i > 0,
      nowMs,
    })
  );
  return { groupingType, orders };
}

function normalizePrivateKey(key: unknown): string {
  if (typeof key !== 'string' || !/^(0x)?[0-9a-fA-F]{80}$/.test(key)) {
    // never echo the value: it is a secret
    throw new RangeError('Lighter signer: apiKeyPrivateKey must be 40 bytes of hex (80 hex chars, optional 0x)');
  }
  return key.startsWith('0x') ? key.slice(2).toLowerCase() : key.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Binary resolution and verification
// ---------------------------------------------------------------------------------------------

export function lighterSignerPlatformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function resolveLighterSignerBinary(
  platform: string = process.platform,
  arch: string = process.arch
): LighterSignerBinary {
  const key = lighterSignerPlatformKey(platform, arch);
  const binary = LIGHTER_SIGNER_BINARIES[key];
  if (!binary) {
    throw new LighterSignerError(
      `No pinned Lighter signer for ${key}. Supported: ${Object.keys(LIGHTER_SIGNER_BINARIES).join(', ')}`
    );
  }
  return binary;
}

export function defaultLighterSignerPath(binary: LighterSignerBinary = resolveLighterSignerBinary()): string {
  const override = process.env[LIGHTER_SIGNER_PATH_ENV];
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), LIGHTER_SIGNER_DIR, binary.file);
}

// Hash the file and compare it with the pinned value. Returns the hash; throws on any mismatch.
export function verifyLighterSignerBinary(filePath: string, binary: LighterSignerBinary): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new LighterSignerError(
      `Lighter signer library not found at ${filePath}. Run "npm run lighter:signer" to install ${binary.file}.`
    );
  }
  if (!stat.isFile()) {
    throw new LighterSignerError(`Lighter signer library path ${filePath} is not a regular file`);
  }
  const actual = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== binary.sha256) {
    throw new LighterSignerError(
      `Lighter signer library ${filePath} failed verification: sha256 ${actual}, expected ${binary.sha256} ` +
      `(${binary.file} at lighter-python ${LIGHTER_SIGNER_COMMIT.slice(0, 7)}). Refusing to load it; ` +
      'run "npm run lighter:signer" to reinstall.'
    );
  }
  return actual;
}

export function assertLighterSignerLoadAllowed(): void {
  // Literal process.env.NEXT_RUNTIME so Next's build-time define also catches bundled code
  if (process.env.NEXT_RUNTIME) {
    throw new LighterSignerError(
      `The Lighter signer cannot be loaded inside Next.js (NEXT_RUNTIME=${process.env.NEXT_RUNTIME}). ` +
      'Sign Lighter transactions in the bot process only.'
    );
  }
  if (typeof window !== 'undefined') {
    throw new LighterSignerError('The Lighter signer cannot be loaded in a browser');
  }
}

// The Linux builds are linked against glibc; refuse musl rather than crash inside the library
function assertSupportedLibc(): void {
  if (process.platform !== 'linux') return;
  let header: { glibcVersionRuntime?: string } | undefined;
  try {
    const report = (process as any).report?.getReport?.();
    header = report?.header;
  } catch {
    return; // cannot tell; koffi.load reports a real incompatibility
  }
  if (header && !header.glibcVersionRuntime) {
    throw new LighterSignerError('The Lighter signer needs glibc; musl-based systems (e.g. Alpine) are not supported');
  }
}

// ---------------------------------------------------------------------------------------------
// Native library (one per process)
// ---------------------------------------------------------------------------------------------

type KoffiModule = typeof Koffi;
type NativeFn = (...args: any[]) => any;

interface RawSignedTx {
  txType: number;
  txInfo: unknown;
  txHash: unknown;
  messageToSign: unknown;
  err: unknown;
}

interface RawStrOrErr {
  str: unknown;
  err: unknown;
}

interface NativeLibrary {
  path: string;
  sha256: string;
  koffi: KoffiModule;
  Free: NativeFn;
  CreateClient: NativeFn;
  SignCreateOrder: NativeFn;
  SignCreateGroupedOrders: NativeFn;
  SignCancelOrder: NativeFn;
  SignCancelAllOrders: NativeFn;
  SignUpdateLeverage: NativeFn;
  CreateAuthToken: NativeFn;
}

interface ProcessSignerState {
  library: NativeLibrary | null;
  chainId: number | null;
  clients: Map<string, string>; // `${accountIndex}:${apiKeyIndex}` -> sha256 of the private key
}

const PROCESS_STATE_KEY = Symbol.for('aster-lick-hunter.lighter-signer');

function processState(): ProcessSignerState {
  const holder = globalThis as unknown as Record<symbol, ProcessSignerState | undefined>;
  let state = holder[PROCESS_STATE_KEY];
  if (!state) {
    state = { library: null, chainId: null, clients: new Map() };
    holder[PROCESS_STATE_KEY] = state;
  }
  return state;
}

// Resolved at call time through createRequire so bundlers never follow it into a route bundle
function requireKoffi(): KoffiModule {
  const anchor = typeof __filename === 'string' && path.isAbsolute(__filename)
    ? __filename
    : path.join(process.cwd(), 'package.json');
  return nodeModule.createRequire(anchor)('koffi') as KoffiModule;
}

function expectLayout(
  koffi: KoffiModule,
  name: string,
  type: Koffi.TypeObject,
  size: number,
  offsets: Record<string, number>
): void {
  const actualSize = koffi.sizeof(type);
  if (actualSize !== size) {
    throw new LighterSignerError(`Lighter signer ABI mismatch: sizeof(${name}) is ${actualSize}, expected ${size}`);
  }
  for (const [member, offset] of Object.entries(offsets)) {
    const actual = koffi.offsetof(type, member);
    if (actual !== offset) {
      throw new LighterSignerError(`Lighter signer ABI mismatch: ${name}.${member} at offset ${actual}, expected ${offset}`);
    }
  }
}

function loadNativeLibrary(libraryPath: string, binary: LighterSignerBinary): NativeLibrary {
  // Verify first, every time, so a swapped file is always reported as such
  const sha256 = verifyLighterSignerBinary(libraryPath, binary);
  const state = processState();
  if (state.library) {
    if (state.library.path !== libraryPath) {
      throw new LighterSignerError(
        `Lighter signer is already loaded from ${state.library.path}; one signer library per process ` +
        `(requested ${libraryPath})`
      );
    }
    return state.library;
  }

  assertSupportedLibc();
  const koffi = requireKoffi();
  if (koffi.sizeof('void *') !== 8) {
    throw new LighterSignerError('Lighter signer needs a 64-bit process');
  }

  // Anonymous structs: koffi type names are process-global and must not clash on a re-import
  const SignedTxResponse = koffi.struct({
    txType: 'uint8_t',
    txInfo: 'void *',
    txHash: 'void *',
    messageToSign: 'void *',
    err: 'void *',
  });
  const StrOrErr = koffi.struct({ str: 'void *', err: 'void *' });
  const CreateOrderTxReq = koffi.struct({
    MarketIndex: 'int64_t',
    ClientOrderIndex: 'int64_t',
    BaseAmount: 'int64_t',
    Price: 'uint32_t',
    IsAsk: 'uint8_t',
    Type: 'uint8_t',
    TimeInForce: 'uint8_t',
    ReduceOnly: 'uint8_t',
    TriggerPrice: 'uint32_t',
    OrderExpiry: 'int64_t',
  });
  expectLayout(koffi, 'CreateOrderTxReq', CreateOrderTxReq, 48, {
    MarketIndex: 0, ClientOrderIndex: 8, BaseAmount: 16, Price: 24, IsAsk: 28,
    Type: 29, TimeInForce: 30, ReduceOnly: 31, TriggerPrice: 32, OrderExpiry: 40,
  });
  expectLayout(koffi, 'SignedTxResponse', SignedTxResponse, 40, {
    txType: 0, txInfo: 8, txHash: 16, messageToSign: 24, err: 32,
  });
  expectLayout(koffi, 'StrOrErr', StrOrErr, 16, { str: 0, err: 8 });

  let lib: Koffi.LibraryHandle;
  try {
    lib = koffi.load(libraryPath);
  } catch (error) {
    throw new LighterSignerError(
      `Failed to load the Lighter signer library ${libraryPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Price and TriggerPrice are uint32_t: the C int carries the same bits and Go reads them as uint32
  const library: NativeLibrary = {
    path: libraryPath,
    sha256,
    koffi,
    Free: lib.func('Free', 'void', ['void *']),
    CreateClient: lib.func('CreateClient', 'void *', ['const char *', 'const char *', 'int', 'int', 'int64_t']),
    SignCreateOrder: lib.func('SignCreateOrder', SignedTxResponse, [
      'int64_t', 'int64_t', 'int64_t', 'uint32_t', 'int', 'int', 'int', 'int', 'uint32_t', 'int64_t',
      'int64_t', 'int', 'int', 'uint8_t', 'uint8_t', 'uint8_t', 'int64_t', 'int', 'int64_t',
    ]),
    SignCreateGroupedOrders: lib.func('SignCreateGroupedOrders', SignedTxResponse, [
      'uint8_t', koffi.pointer(CreateOrderTxReq), 'int', 'int64_t', 'int', 'int',
      'uint8_t', 'uint8_t', 'uint8_t', 'int64_t', 'int', 'int64_t',
    ]),
    SignCancelOrder: lib.func('SignCancelOrder', SignedTxResponse, [
      'int64_t', 'int64_t', 'uint8_t', 'int64_t', 'int', 'int64_t',
    ]),
    SignCancelAllOrders: lib.func('SignCancelAllOrders', SignedTxResponse, [
      'int', 'int64_t', 'int64_t', 'uint8_t', 'int64_t', 'int', 'int64_t',
    ]),
    SignUpdateLeverage: lib.func('SignUpdateLeverage', SignedTxResponse, [
      'int64_t', 'int', 'int', 'uint8_t', 'int64_t', 'int', 'int64_t',
    ]),
    CreateAuthToken: lib.func('CreateAuthToken', StrOrErr, ['int64_t', 'int', 'int64_t']),
  };
  state.library = library;
  logWithTimestamp(`Lighter signer: loaded ${path.basename(libraryPath)} (sha256 ${sha256.slice(0, 12)}...)`);
  return library;
}

// Read a library-allocated C string and release it with the library's Free (same allocator/CRT)
function takeString(library: NativeLibrary, pointer: unknown): string | null {
  if (pointer === null || pointer === undefined) return null;
  if (typeof pointer !== 'bigint') {
    throw new LighterSignerError(`Lighter signer returned an unexpected pointer value (${typeof pointer})`);
  }
  if (pointer === BigInt(0)) return null;
  try {
    return library.koffi.decode(pointer, 'char', -1) as string;
  } finally {
    library.Free(pointer);
  }
}

// Take every pointer exactly once, even when one of them fails to decode
function takeStrings(library: NativeLibrary, pointers: unknown[]): Array<string | null> {
  const values: Array<string | null> = [];
  let failure: unknown = null;
  for (const pointer of pointers) {
    try {
      values.push(takeString(library, pointer));
    } catch (error) {
      failure = failure ?? error;
      values.push(null);
    }
  }
  if (failure) throw failure;
  return values;
}

// ---------------------------------------------------------------------------------------------
// Output checks: the signed tx must say exactly what was requested
// ---------------------------------------------------------------------------------------------

function parseTxInfo(txInfo: string, what: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(txInfo);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new LighterSignerError(`Lighter signer returned unparseable tx_info for ${what}`);
}

function expectFields(actual: Record<string, unknown>, expected: Record<string, number>, what: string): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new LighterSignerError(
        `Lighter signer output does not match the ${what} request: ${key} is ${describeValue(actual[key])}, ` +
        `expected ${value}. Refusing to use this tx.`
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------------------------

class NativeLighterSigner implements LighterSigner {
  readonly libraryPath: string;
  readonly librarySha256: string;

  constructor(
    private readonly library: NativeLibrary,
    readonly chainId: number,
    readonly accountIndex: number,
    readonly apiKeyIndex: number
  ) {
    this.libraryPath = library.path;
    this.librarySha256 = library.sha256;
  }

  signCreateOrder(request: LighterCreateOrderRequest): LighterSignedTx {
    const nonce = guardNonce(request?.nonce);
    const order = normalizeLighterOrder(request);
    const raw: RawSignedTx = this.library.SignCreateOrder(
      order.MarketIndex, order.ClientOrderIndex, order.BaseAmount, order.Price, order.IsAsk, order.Type,
      order.TimeInForce, order.ReduceOnly, order.TriggerPrice, order.OrderExpiry,
      0, 0, 0, // no integrator
      0, 0, // default self-trade behaviour
      0, // skipNonce off
      nonce, this.apiKeyIndex, this.accountIndex
    );
    const signed = this.finish(raw, LIGHTER_TX_TYPE.CREATE_ORDER, nonce, 'create-order');
    expectFields(signed.info, { ...order }, 'create-order');
    return signed.tx;
  }

  signGroupedOrders(request: LighterGroupedOrdersRequest): LighterSignedTx {
    const nonce = guardNonce(request?.nonce);
    const { groupingType, orders } = guardGroupedOrders(request, Date.now());
    const raw: RawSignedTx = this.library.SignCreateGroupedOrders(
      groupingType, orders, orders.length,
      0, 0, 0, // no integrator
      0, 0, // default self-trade behaviour
      0, // skipNonce off
      nonce, this.apiKeyIndex, this.accountIndex
    );
    const signed = this.finish(raw, LIGHTER_TX_TYPE.CREATE_GROUPED_ORDERS, nonce, 'grouped-orders');
    expectFields(signed.info, { GroupingType: groupingType }, 'grouped-orders');
    const echoed = signed.info.Orders;
    if (!Array.isArray(echoed) || echoed.length !== orders.length) {
      throw new LighterSignerError('Lighter signer output does not match the grouped-orders request: order count differs');
    }
    orders.forEach((order, i) => expectFields(echoed[i] ?? {}, { ...order }, `grouped-orders[${i}]`));
    return signed.tx;
  }

  signCancelOrder(request: LighterCancelOrderRequest): LighterSignedTx {
    const nonce = guardNonce(request?.nonce);
    const marketIndex = guardMarketIndex('marketIndex', request.marketIndex);
    const index = guardOrderIndex(request.index);
    const raw: RawSignedTx = this.library.SignCancelOrder(marketIndex, index, 0, nonce, this.apiKeyIndex, this.accountIndex);
    const signed = this.finish(raw, LIGHTER_TX_TYPE.CANCEL_ORDER, nonce, 'cancel-order');
    expectFields(signed.info, { MarketIndex: marketIndex }, 'cancel-order');
    // Index can exceed 2^53, so compare the raw text rather than the parsed number
    const echoedIndex = /"Index":(\d+)[,}]/.exec(signed.tx.txInfo)?.[1];
    if (echoedIndex !== index.toString()) {
      throw new LighterSignerError(
        `Lighter signer output does not match the cancel-order request: Index is ${echoedIndex ?? 'missing'}, ` +
        `expected ${index}. Refusing to use this tx.`
      );
    }
    return signed.tx;
  }

  signCancelAll(request: LighterCancelAllRequest): LighterSignedTx {
    const nonce = guardNonce(request?.nonce);
    const timeInForce = guardOneOf('timeInForce', request.timeInForce, CANCEL_ALL_TIF_VALUES);
    const marketIndex = request.marketIndex === undefined || request.marketIndex === LIGHTER_ALL_MARKETS
      ? LIGHTER_ALL_MARKETS
      : guardMarketIndex('marketIndex', request.marketIndex);
    let time: number;
    if (timeInForce === LIGHTER_CANCEL_ALL_TIME_IN_FORCE.SCHEDULED) {
      const now = Date.now();
      time = guardInt('time', request.time, now + LIGHTER_MIN_CANCEL_ALL_DELAY_MS, now + LIGHTER_MAX_CANCEL_ALL_DELAY_MS);
      if (marketIndex !== LIGHTER_ALL_MARKETS) {
        throw new RangeError('Lighter signer: a scheduled cancel-all applies to every market; omit marketIndex');
      }
    } else {
      time = guardInt('time', request.time, 0, 0);
    }
    const raw: RawSignedTx = this.library.SignCancelAllOrders(
      timeInForce, time, marketIndex, 0, nonce, this.apiKeyIndex, this.accountIndex
    );
    const signed = this.finish(raw, LIGHTER_TX_TYPE.CANCEL_ALL_ORDERS, nonce, 'cancel-all');
    expectFields(signed.info, { TimeInForce: timeInForce, Time: time }, 'cancel-all');
    // Attribute "5" scopes the cancel to one market; absent means every market
    const attributes = signed.info.L2TxAttributes as Record<string, unknown> | null | undefined;
    const scopedMarket = attributes && typeof attributes === 'object' ? attributes['5'] : undefined;
    const expectedScope = marketIndex === LIGHTER_ALL_MARKETS ? undefined : marketIndex;
    if (scopedMarket !== expectedScope) {
      throw new LighterSignerError(
        `Lighter signer output does not match the cancel-all request: market scope is ${describeValue(scopedMarket)}, ` +
        `expected ${describeValue(expectedScope)}. Refusing to use this tx.`
      );
    }
    return signed.tx;
  }

  signUpdateLeverage(request: LighterUpdateLeverageRequest): LighterSignedTx {
    const nonce = guardNonce(request?.nonce);
    const marketIndex = guardMarketIndex('marketIndex', request.marketIndex);
    const initialMarginFraction = guardInt(
      'initialMarginFraction', request.initialMarginFraction, 1, LIGHTER_MAX_INITIAL_MARGIN_FRACTION
    );
    const marginMode = guardOneOf('marginMode', request.marginMode, MARGIN_MODES);
    const raw: RawSignedTx = this.library.SignUpdateLeverage(
      marketIndex, initialMarginFraction, marginMode, 0, nonce, this.apiKeyIndex, this.accountIndex
    );
    const signed = this.finish(raw, LIGHTER_TX_TYPE.UPDATE_LEVERAGE, nonce, 'update-leverage');
    expectFields(signed.info, {
      MarketIndex: marketIndex,
      InitialMarginFraction: initialMarginFraction,
      MarginMode: marginMode,
    }, 'update-leverage');
    return signed.tx;
  }

  createAuthToken(deadlineSec: number): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const deadline = guardInt('deadlineSec', deadlineSec, nowSec + 1, nowSec + LIGHTER_MAX_AUTH_TOKEN_LIFETIME_SEC);
    const raw: RawStrOrErr = this.library.CreateAuthToken(deadline, this.apiKeyIndex, this.accountIndex);
    const [err, token] = takeStrings(this.library, [raw.err, raw.str]);
    if (err) throw new LighterSignerError(`Lighter signer could not create an auth token: ${err}`);
    const prefix = `${deadline}:${this.accountIndex}:${this.apiKeyIndex}:`;
    // Never put the token itself in an error message
    if (!token || !token.startsWith(prefix) || !/^[0-9a-f]{160}$/.test(token.slice(prefix.length))) {
      throw new LighterSignerError('Lighter signer returned an auth token in an unexpected format');
    }
    return token;
  }

  private finish(
    raw: RawSignedTx,
    expectedTxType: number,
    nonce: number,
    what: string
  ): { tx: LighterSignedTx; info: Record<string, unknown> } {
    const [err, txInfo, txHash] = takeStrings(this.library, [raw.err, raw.txInfo, raw.txHash, raw.messageToSign]);
    if (err) throw new LighterSignerError(`Lighter signer rejected the ${what} tx: ${err}`);
    if (raw.txType !== expectedTxType) {
      throw new LighterSignerError(`Lighter signer returned tx type ${raw.txType} for ${what}, expected ${expectedTxType}`);
    }
    if (!txInfo) throw new LighterSignerError(`Lighter signer returned no tx_info for ${what}`);
    if (!txHash || !/^[0-9a-f]{80}$/.test(txHash)) {
      throw new LighterSignerError(`Lighter signer returned a malformed tx hash for ${what}`);
    }
    const info = parseTxInfo(txInfo, what);
    expectFields(info, { AccountIndex: this.accountIndex, ApiKeyIndex: this.apiKeyIndex, Nonce: nonce }, what);
    const expiredAt = info.ExpiredAt;
    if (typeof expiredAt !== 'number' || !Number.isSafeInteger(expiredAt) || expiredAt <= 0) {
      throw new LighterSignerError(`Lighter signer returned an invalid ExpiredAt for ${what}`);
    }
    return { tx: { txType: raw.txType, txInfo, txHash, nonce, expiredAt }, info };
  }
}

// Load the library (once per process) and register the API key with it. Calling again with the same
// key returns a signer for the already registered client. Throws on a second network, on a different
// private key for an (account, key index) pair already registered, and inside Next.js.
export function loadLighterSigner(options: LoadLighterSignerOptions): LighterSigner {
  assertLighterSignerLoadAllowed();
  if (!options || typeof options !== 'object') {
    throw new RangeError('Lighter signer: options are required');
  }
  const chainId = guardOneOf('chainId', options.chainId, LIGHTER_KNOWN_CHAIN_IDS);
  const accountIndex = guardInt('accountIndex', options.accountIndex, 1, LIGHTER_MAX_ACCOUNT_INDEX);
  const apiKeyIndex = guardInt('apiKeyIndex', options.apiKeyIndex, 0, LIGHTER_MAX_API_KEY_INDEX);
  const privateKey = normalizePrivateKey(options.apiKeyPrivateKey);

  const binary = resolveLighterSignerBinary();
  const libraryPath = options.libraryPath ? path.resolve(options.libraryPath) : defaultLighterSignerPath(binary);
  const library = loadNativeLibrary(libraryPath, binary);

  const state = processState();
  if (state.chainId !== null && state.chainId !== chainId) {
    throw new LighterSignerError(
      `Lighter signer is already set up for chain ${state.chainId}; one network per process (requested ${chainId})`
    );
  }
  const clientKey = `${accountIndex}:${apiKeyIndex}`;
  const keyFingerprint = createHash('sha256').update(privateKey).digest('hex');
  const registered = state.clients.get(clientKey);
  if (registered !== undefined && registered !== keyFingerprint) {
    throw new LighterSignerError(
      `Lighter signer already holds a different private key for account ${accountIndex} key index ${apiKeyIndex}; ` +
      'restart the bot to switch keys'
    );
  }
  if (registered === undefined) {
    // Empty URL: the library gets no HTTP client, so it can never fetch nonces or call out by itself
    const [err] = takeStrings(library, [library.CreateClient('', privateKey, chainId, apiKeyIndex, accountIndex)]);
    if (err) {
      throw new LighterSignerError(
        `Lighter signer rejected the API key for account ${accountIndex} key index ${apiKeyIndex}: ${err}`
      );
    }
    state.chainId = chainId;
    state.clients.set(clientKey, keyFingerprint);
    logWithTimestamp(`Lighter signer: registered account ${accountIndex} key index ${apiKeyIndex} on chain ${chainId}`);
  }
  return new NativeLighterSigner(library, chainId, accountIndex, apiKeyIndex);
}
