/**
 * @jest-environment node
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LIGHTER_CANCEL_ALL_TIME_IN_FORCE,
  LIGHTER_GROUPING_TYPE,
  LIGHTER_MARGIN_MODE,
  LIGHTER_ORDER_TYPE,
  LIGHTER_SIGNER_BASE_URL,
  LIGHTER_SIGNER_BINARIES,
  LIGHTER_SIGNER_COMMIT,
  LIGHTER_TIME_IN_FORCE,
  LIGHTER_TX_TYPE,
  LighterSignerError,
  guardInt48,
  guardMarketIndex,
  guardNonce,
  guardOrderExpiry,
  guardOrderIndex,
  guardUint32,
  loadLighterSigner,
  normalizeLighterOrder,
  resolveLighterSignerBinary,
  type LighterOrderParams,
  type LighterSigner,
} from '../../../src/lib/exchange/lighter/signer';

const installer = require('../../../scripts/lighter-signer.js');

// Generated offline with the library's GenerateAPIKey for these tests only. It is not registered
// on any Lighter network and controls nothing.
const THROWAWAY_KEY = '0x280f45af48b596414d4a5fd8774eb5a59157fd0e96a7bc8a5e0bbe7aceab3c67096492a24ef4b612';
const ACCOUNT = 12345;
const KEY_INDEX = 3;
const TESTNET_CHAIN = 300;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function koffiIsLoaded(): boolean {
  const marker = `${path.sep}node_modules${path.sep}koffi${path.sep}`;
  return Object.keys(require.cache).some(key => key.includes(marker));
}

const binary = (() => {
  try {
    return resolveLighterSignerBinary();
  } catch {
    return null;
  }
})();

const SEARCH_DIRS = [
  path.join(process.cwd(), 'vendor', 'lighter-signer'),
  '/home/user/lighter/lighter-python/lighter/signers',
];
const signerPath = binary
  ? SEARCH_DIRS.map(dir => path.join(dir, binary.file)).find(candidate => fs.existsSync(candidate))
  : undefined;

const SKIP_REASON = binary
  ? `no ${binary.file} in ${SEARCH_DIRS.join(' or ')}; run "npm run lighter:signer"`
  : `no pinned signer for ${process.platform}-${process.arch}`;
// CI that must exercise the native signer sets LIGHTER_SIGNER_REQUIRED=1: a missing binary then fails the suite
// instead of skipping it
const SIGNER_REQUIRED = process.env.LIGHTER_SIGNER_REQUIRED === '1';
if (!signerPath) {
  // console is mocked in tests/setup.ts, so write the reason straight to stderr
  process.stderr.write(`\n[lighter signer tests] ${SIGNER_REQUIRED ? 'FAILING' : 'SKIPPING'} native signing tests: ${SKIP_REASON}\n\n`);
}
if (!signerPath && SIGNER_REQUIRED) {
  describe('native signer (LIGHTER_SIGNER_REQUIRED=1)', () => {
    it('is installed', () => {
      throw new Error(`LIGHTER_SIGNER_REQUIRED=1 but ${SKIP_REASON}`);
    });
  });
}
const describeWithSigner = signerPath ? describe : describe.skip;
const itWithBinaryTable = binary ? it : it.skip;

function limitOrder(overrides: Partial<LighterOrderParams> = {}): LighterOrderParams {
  return {
    marketIndex: 1,
    clientOrderIndex: 176_000_000_001,
    baseAmount: 1234,       // 0.01234 BTC at size_decimals 5 (spec §3.2 worked example)
    price: 973124,          // $97,312.4 at price_decimals 1
    isAsk: false,
    type: LIGHTER_ORDER_TYPE.LIMIT,
    timeInForce: LIGHTER_TIME_IN_FORCE.GTT,
    reduceOnly: false,
    triggerPrice: 0,
    orderExpiry: Date.now() + 28 * DAY,
    ...overrides,
  };
}

function ocoLegs(expiry: number, overrides: [Partial<LighterOrderParams>, Partial<LighterOrderParams>] = [{}, {}]) {
  const common = {
    marketIndex: 1,
    baseAmount: 1000,
    isAsk: true,
    timeInForce: LIGHTER_TIME_IN_FORCE.IOC,
    reduceOnly: true,
    orderExpiry: expiry,
  };
  return [
    { ...common, clientOrderIndex: 11, type: LIGHTER_ORDER_TYPE.STOP_LOSS, triggerPrice: 950000, price: 900000, ...overrides[0] },
    { ...common, clientOrderIndex: 12, type: LIGHTER_ORDER_TYPE.TAKE_PROFIT, triggerPrice: 1050000, price: 1040000, ...overrides[1] },
  ] as LighterOrderParams[];
}

describe('Lighter signer without the native library', () => {
  it('loads nothing when the module is imported', () => {
    expect(koffiIsLoaded()).toBe(false);
  });

  it('pins the binaries from spec §6.2 and matches the install script', () => {
    expect(LIGHTER_SIGNER_COMMIT).toBe('5825eb19867a4dbdd47c02642dc1eec30c30ca73');
    expect(LIGHTER_SIGNER_BINARIES['linux-x64']).toEqual({
      file: 'lighter-signer-linux-amd64.so',
      sha256: '49c6b61e0e95a4a70f2a252e469c393760c929d61179c340e2932ab62882caf2',
    });
    expect(LIGHTER_SIGNER_BINARIES['linux-arm64'].sha256).toBe('3b6fd0b8f4caecbff9ce817dffb11a2321f078e0b4acc9a58623354bb55cc289');
    expect(LIGHTER_SIGNER_BINARIES['darwin-arm64'].sha256).toBe('b8e602542721a11aff4236a247e775150b421c0eb7532442209658a5b0c22f31');
    expect(LIGHTER_SIGNER_BINARIES['darwin-x64'].sha256).toBe('a74e230cebde6c61d35de09587f0980b383b991fa694f974b4070adec6b64bb3');
    expect(LIGHTER_SIGNER_BINARIES['win32-x64'].sha256).toBe('3f6baac6015a27d652971947442c69f26f37cf6bdae7fd74f3c05cd2d8c194b1');

    expect(installer.LIGHTER_SIGNER_COMMIT).toBe(LIGHTER_SIGNER_COMMIT);
    expect(installer.LIGHTER_SIGNER_BASE_URL).toBe(LIGHTER_SIGNER_BASE_URL);
    expect(JSON.parse(JSON.stringify(installer.LIGHTER_SIGNER_BINARIES))).toEqual(JSON.parse(JSON.stringify(LIGHTER_SIGNER_BINARIES)));
  });

  it('picks the binary by platform and arch and refuses unknown ones', () => {
    expect(resolveLighterSignerBinary('linux', 'x64').file).toBe('lighter-signer-linux-amd64.so');
    expect(resolveLighterSignerBinary('linux', 'arm64').file).toBe('lighter-signer-linux-arm64.so');
    expect(resolveLighterSignerBinary('darwin', 'arm64').file).toBe('lighter-signer-darwin-arm64.dylib');
    expect(resolveLighterSignerBinary('darwin', 'x64').file).toBe('lighter-signer-darwin-amd64.dylib');
    expect(resolveLighterSignerBinary('win32', 'x64').file).toBe('lighter-signer-windows-amd64.dll');
    for (const [platform, arch] of [['linux', 'ia32'], ['win32', 'arm64'], ['freebsd', 'x64'], ['linux', 'arm']]) {
      expect(() => resolveLighterSignerBinary(platform, arch)).toThrow(LighterSignerError);
    }
  });

  it('refuses to load inside Next.js before touching the file system', () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    try {
      expect(() => loadLighterSigner({
        chainId: TESTNET_CHAIN,
        accountIndex: ACCOUNT,
        apiKeyIndex: KEY_INDEX,
        apiKeyPrivateKey: THROWAWAY_KEY,
        libraryPath: path.join(os.tmpdir(), 'does-not-exist.so'),
      })).toThrow(/Next\.js/);
    } finally {
      delete process.env.NEXT_RUNTIME;
    }
    expect(koffiIsLoaded()).toBe(false);
  });

  it('validates the options before loading anything', () => {
    const base = { chainId: TESTNET_CHAIN, accountIndex: ACCOUNT, apiKeyIndex: KEY_INDEX, apiKeyPrivateKey: THROWAWAY_KEY };
    expect(() => loadLighterSigner({ ...base, chainId: 1 })).toThrow(RangeError);           // not a profile chain id
    expect(() => loadLighterSigner({ ...base, apiKeyIndex: 255 })).toThrow(RangeError);     // library "default client"
    expect(() => loadLighterSigner({ ...base, apiKeyIndex: -1 })).toThrow(RangeError);
    expect(() => loadLighterSigner({ ...base, accountIndex: 0 })).toThrow(RangeError);
    expect(() => loadLighterSigner({ ...base, accountIndex: 2 ** 48 - 1 })).toThrow(RangeError);

    const shortKey = `0x${'ab'.repeat(32)}`;
    let message = '';
    try {
      loadLighterSigner({ ...base, apiKeyPrivateKey: shortKey });
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/apiKeyPrivateKey/);
    expect(message).not.toContain('abab');
    expect(koffiIsLoaded()).toBe(false);
  });

  itWithBinaryTable('refuses a binary whose sha256 does not match, before koffi is loaded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lighter-signer-'));
    const fake = path.join(dir, binary!.file);
    fs.writeFileSync(fake, 'definitely not the pinned signer');
    try {
      expect(() => loadLighterSigner({
        chainId: TESTNET_CHAIN, accountIndex: ACCOUNT, apiKeyIndex: KEY_INDEX, apiKeyPrivateKey: THROWAWAY_KEY, libraryPath: fake,
      })).toThrow(/failed verification: sha256 [0-9a-f]{64}, expected/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(koffiIsLoaded()).toBe(false);
  });

  itWithBinaryTable('explains how to install a missing binary', () => {
    expect(() => loadLighterSigner({
      chainId: TESTNET_CHAIN, accountIndex: ACCOUNT, apiKeyIndex: KEY_INDEX, apiKeyPrivateKey: THROWAWAY_KEY,
      libraryPath: path.join(os.tmpdir(), `missing-${Date.now()}`, binary!.file),
    })).toThrow(/npm run lighter:signer/);
    expect(koffiIsLoaded()).toBe(false);
  });

  describe('range guards (koffi would silently wrap these, spec §6.3)', () => {
    it('uint32 prices: 1..2^32-1 only', () => {
      expect(guardUint32('price', 1)).toBe(1);
      expect(guardUint32('price', 4294967295)).toBe(4294967295);
      expect(guardUint32('triggerPrice', 0, true)).toBe(0);
      for (const bad of [0, 4294967296, 4294967396, -1, 100.7, Number.NaN, Infinity, '100', null, undefined]) {
        expect(() => guardUint32('price', bad)).toThrow(RangeError);
      }
    });

    it('int48 sizes and client order indexes: 1..2^48-1 only', () => {
      expect(guardInt48('baseAmount', 2 ** 48 - 1)).toBe(2 ** 48 - 1);
      for (const bad of [0, 2 ** 48, -1, 1.5, 2 ** 53 + 2]) {
        expect(() => guardInt48('baseAmount', bad)).toThrow(RangeError);
      }
      expect(guardInt48('baseAmount', 0, true)).toBe(0);
    });

    it('market index: 0..2^48-1 except the 255 "no market" marker', () => {
      expect(guardMarketIndex('marketIndex', 0)).toBe(0);
      expect(guardMarketIndex('marketIndex', 2048)).toBe(2048);
      for (const bad of [255, -1, 2 ** 48, 1.2]) {
        expect(() => guardMarketIndex('marketIndex', bad)).toThrow(RangeError);
      }
    });

    it('nonce: explicit, never -1', () => {
      expect(guardNonce(0)).toBe(0);
      for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => guardNonce(bad)).toThrow(RangeError);
      }
    });

    it('order expiry: 0 or a ms timestamp 5 min to 30 days ahead, never -1', () => {
      const now = 1_800_000_000_000;
      expect(guardOrderExpiry('orderExpiry', 0, now)).toBe(0);
      expect(guardOrderExpiry('orderExpiry', now + 28 * DAY, now)).toBe(now + 28 * DAY);
      for (const bad of [-1, now + MINUTE, now + 31 * DAY, Math.floor(now / 1000) + 3600, now + 0.5 + 28 * DAY]) {
        expect(() => guardOrderExpiry('orderExpiry', bad, now)).toThrow(RangeError);
      }
    });

    it('order index: exact client order index or order_index, ids above 2^53 as strings', () => {
      expect(guardOrderIndex(11)).toBe(BigInt(11));
      expect(guardOrderIndex('576460752303423611').toString()).toBe('576460752303423611');
      expect(guardOrderIndex(BigInt('1152921504606846975')).toString()).toBe('1152921504606846975'); // 2^60-1
      for (const bad of [0, -5, Number('576460752303423611'), '1152921504606846976', BigInt(2) ** BigInt(64), '12a', '', 1.5]) {
        expect(() => guardOrderIndex(bad)).toThrow(RangeError);
      }
    });

    it('orders: types, flags and position-tied sizes', () => {
      const now = 1_800_000_000_000;
      const order = limitOrder({ orderExpiry: now + 28 * DAY });
      expect(normalizeLighterOrder(order, { nowMs: now })).toEqual({
        MarketIndex: 1,
        ClientOrderIndex: 176_000_000_001,
        BaseAmount: 1234,
        Price: 973124,
        IsAsk: 0,
        Type: 0,
        TimeInForce: 1,
        ReduceOnly: 0,
        TriggerPrice: 0,
        OrderExpiry: now + 28 * DAY,
      });
      const bad: Array<Partial<Record<keyof LighterOrderParams, unknown>>> = [
        { baseAmount: 0 },                     // position-tied size refused outside OTO/OTOCO children
        { clientOrderIndex: 0 },
        { clientOrderIndex: 2 ** 48 },
        { price: 0 },
        { price: 4294967396 },
        { triggerPrice: 4294967296 },
        { isAsk: 1 },
        { reduceOnly: 'yes' },
        { type: 7 },
        { timeInForce: 3 },
        { marketIndex: 255 },
        { orderExpiry: -1 },
      ];
      for (const overrides of bad) {
        expect(() => normalizeLighterOrder({ ...order, ...overrides } as LighterOrderParams, { nowMs: now })).toThrow(RangeError);
      }
      // A zero size needs both the explicit allowance and reduce-only
      expect(normalizeLighterOrder({ ...order, baseAmount: 0, reduceOnly: true }, { nowMs: now, allowZeroBaseAmount: true }).BaseAmount).toBe(0);
      expect(() => normalizeLighterOrder({ ...order, baseAmount: 0 }, { nowMs: now, allowZeroBaseAmount: true })).toThrow(RangeError);
    });
  });

  describe('install script (offline)', () => {
    const payload = Buffer.from('pretend signer bytes');
    const fakeBinary = { file: 'fake-signer.so', sha256: createHash('sha256').update(payload).digest('hex') };
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lighter-signer-install-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('downloads from the pinned commit and installs only bytes with the pinned hash', async () => {
      const urls: string[] = [];
      await expect(installer.install({
        dir, binary: fakeBinary, download: async (url: string) => { urls.push(url); return Buffer.from('tampered'); },
      })).rejects.toThrow(/sha256 .* expected .*Nothing was installed/);
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(urls).toEqual([`${LIGHTER_SIGNER_BASE_URL}fake-signer.so`]);

      const result = await installer.install({ dir, binary: fakeBinary, download: async () => payload });
      expect(result).toEqual({ status: 'installed', path: path.join(dir, 'fake-signer.so'), sha256: fakeBinary.sha256 });
      expect(fs.readdirSync(dir)).toEqual(['fake-signer.so']);
      expect(installer.verify({ dir, binary: fakeBinary }).ok).toBe(true);
    });

    it('is idempotent and replaces a file that fails verification', async () => {
      const download = jest.fn(async () => payload);
      await installer.install({ dir, binary: fakeBinary, download });
      const again = await installer.install({ dir, binary: fakeBinary, download });
      expect(again.status).toBe('present');
      expect(download).toHaveBeenCalledTimes(1);

      fs.writeFileSync(path.join(dir, 'fake-signer.so'), 'swapped');
      const check = installer.verify({ dir, binary: fakeBinary });
      expect(check.ok).toBe(false);
      expect(check.reason).toMatch(/does not match the pinned/);

      const repaired = await installer.install({ dir, binary: fakeBinary, download });
      expect(repaired.status).toBe('installed');
      expect(download).toHaveBeenCalledTimes(2);
      expect(installer.verify({ dir, binary: fakeBinary }).ok).toBe(true);
    });

    it('reports a missing file in verify mode', () => {
      const check = installer.verify({ dir, binary: fakeBinary });
      expect(check.ok).toBe(false);
      expect(check.reason).toMatch(/not found/);
    });

    it('only accepts known platforms and options', () => {
      expect(installer.resolveBinary('linux-x64')).toEqual(LIGHTER_SIGNER_BINARIES['linux-x64']);
      expect(() => installer.resolveBinary('linux-ia32')).toThrow(/No pinned Lighter signer/);
      expect(installer.parseArgs(['--verify', '--platform', 'darwin-arm64'])).toMatchObject({ verify: true, platform: 'darwin-arm64' });
      expect(() => installer.parseArgs(['--dir'])).toThrow(/needs a value/);
      expect(() => installer.parseArgs(['--force'])).toThrow(/Unknown option/);
    });

    it('honours NO_PROXY for the download host', () => {
      const url = new URL(LIGHTER_SIGNER_BASE_URL);
      expect(installer.proxyFor(url, { HTTPS_PROXY: 'http://127.0.0.1:3128' })).toBe('http://127.0.0.1:3128');
      expect(installer.proxyFor(url, { HTTPS_PROXY: 'http://127.0.0.1:3128', NO_PROXY: 'localhost,.githubusercontent.com' })).toBeNull();
      expect(installer.proxyFor(url, { https_proxy: 'http://p:1', no_proxy: '*' })).toBeNull();
      expect(installer.proxyFor(url, {})).toBeNull();
    });
  });
});

describeWithSigner(`Lighter signer with the native library${signerPath ? '' : ` (SKIPPED: ${SKIP_REASON})`}`, () => {
  let signer: LighterSigner;

  beforeAll(() => {
    signer = loadLighterSigner({
      chainId: TESTNET_CHAIN,
      accountIndex: ACCOUNT,
      apiKeyIndex: KEY_INDEX,
      apiKeyPrivateKey: THROWAWAY_KEY,
      libraryPath: signerPath!,
    });
  });

  it('loads koffi and the verified library on first use', () => {
    expect(koffiIsLoaded()).toBe(true);
    expect(signer.librarySha256).toBe(binary!.sha256);
    expect(signer.chainId).toBe(TESTNET_CHAIN);
  });

  it('signs a LIMIT GTT create-order (tx 14) with an explicit nonce', () => {
    const order = limitOrder();
    const before = Date.now();
    const tx = signer.signCreateOrder({ ...order, nonce: 7 });
    expect(tx.txType).toBe(LIGHTER_TX_TYPE.CREATE_ORDER);
    expect(tx.txHash).toMatch(/^[0-9a-f]{80}$/);
    expect(tx.nonce).toBe(7);
    const info = JSON.parse(tx.txInfo);
    expect(info).toMatchObject({
      AccountIndex: ACCOUNT,
      ApiKeyIndex: KEY_INDEX,
      MarketIndex: 1,
      ClientOrderIndex: 176_000_000_001,
      BaseAmount: 1234,
      Price: 973124,
      IsAsk: 0,
      Type: 0,
      TimeInForce: 1,
      ReduceOnly: 0,
      TriggerPrice: 0,
      OrderExpiry: order.orderExpiry,
      Nonce: 7,
    });
    expect(typeof info.Sig).toBe('string');
    expect(tx.expiredAt).toBe(info.ExpiredAt);
    expect(tx.expiredAt).toBeGreaterThan(before);
    expect(tx.expiredAt).toBeLessThanOrEqual(Date.now() + 10 * MINUTE);
  });

  it('signs a MARKET IOC order and prices above 2^31 exactly', () => {
    const market = signer.signCreateOrder({
      ...limitOrder({ type: LIGHTER_ORDER_TYPE.MARKET, timeInForce: LIGHTER_TIME_IN_FORCE.IOC, orderExpiry: 0, isAsk: true }),
      nonce: 8,
    });
    expect(JSON.parse(market.txInfo)).toMatchObject({ Type: 1, TimeInForce: 0, OrderExpiry: 0, IsAsk: 1, Nonce: 8 });

    const takeProfit = signer.signCreateOrder({
      ...limitOrder({
        type: LIGHTER_ORDER_TYPE.TAKE_PROFIT,
        timeInForce: LIGHTER_TIME_IN_FORCE.IOC,
        isAsk: true,
        reduceOnly: true,
        price: 4294967295,
        triggerPrice: 3000000000,
      }),
      nonce: 9,
    });
    expect(JSON.parse(takeProfit.txInfo)).toMatchObject({ Price: 4294967295, TriggerPrice: 3000000000, ReduceOnly: 1 });
  });

  it('signs an OCO stop-loss + take-profit with an explicit size (tx 28, spec §0 item 8)', () => {
    const expiry = Date.now() + 28 * DAY;
    const tx = signer.signGroupedOrders({ groupingType: LIGHTER_GROUPING_TYPE.OCO, orders: ocoLegs(expiry), nonce: 10 });
    expect(tx.txType).toBe(LIGHTER_TX_TYPE.CREATE_GROUPED_ORDERS);
    expect(tx.txHash).toMatch(/^[0-9a-f]{80}$/);
    const info = JSON.parse(tx.txInfo);
    expect(info).toMatchObject({ AccountIndex: ACCOUNT, ApiKeyIndex: KEY_INDEX, GroupingType: 2, Nonce: 10 });
    expect(info.Orders).toEqual([
      { MarketIndex: 1, ClientOrderIndex: 11, BaseAmount: 1000, Price: 900000, IsAsk: 1, Type: 2, TimeInForce: 0, ReduceOnly: 1, TriggerPrice: 950000, OrderExpiry: expiry },
      { MarketIndex: 1, ClientOrderIndex: 12, BaseAmount: 1000, Price: 1040000, IsAsk: 1, Type: 4, TimeInForce: 0, ReduceOnly: 1, TriggerPrice: 1050000, OrderExpiry: expiry },
    ]);
  });

  it('surfaces the library rejecting OCO legs with different expiries (spec §0 item 9)', () => {
    const expiry = Date.now() + 28 * DAY;
    const legs = ocoLegs(expiry, [{}, { orderExpiry: expiry + 1 }]);
    expect(() => signer.signGroupedOrders({ groupingType: LIGHTER_GROUPING_TYPE.OCO, orders: legs, nonce: 11 }))
      .toThrow(/rejected the grouped-orders tx: .*OrderExpiry is invalid/);
  });

  it('refuses a position-tied OCO and a wrong leg count before signing', () => {
    const expiry = Date.now() + 28 * DAY;
    const tied = ocoLegs(expiry, [{ baseAmount: 0 }, { baseAmount: 0 }]);
    expect(() => signer.signGroupedOrders({ groupingType: LIGHTER_GROUPING_TYPE.OCO, orders: tied, nonce: 12 })).toThrow(RangeError);
    expect(() => signer.signGroupedOrders({
      groupingType: LIGHTER_GROUPING_TYPE.OCO, orders: ocoLegs(expiry).slice(0, 1), nonce: 12,
    })).toThrow(RangeError);
  });

  it('signs an OTOCO entry with position-tied children', () => {
    const expiry = Date.now() + 28 * DAY;
    const [stopLoss, takeProfit] = ocoLegs(expiry, [{ baseAmount: 0, clientOrderIndex: 21 }, { baseAmount: 0, clientOrderIndex: 22 }]);
    const entry = limitOrder({ clientOrderIndex: 20, baseAmount: 1000, price: 1000000, timeInForce: LIGHTER_TIME_IN_FORCE.IOC, orderExpiry: 0 });
    const tx = signer.signGroupedOrders({ groupingType: LIGHTER_GROUPING_TYPE.OTOCO, orders: [entry, stopLoss, takeProfit], nonce: 13 });
    const info = JSON.parse(tx.txInfo);
    expect(info.GroupingType).toBe(3);
    expect(info.Orders.map((o: { BaseAmount: number }) => o.BaseAmount)).toEqual([1000, 0, 0]);
  });

  it('signs a cancel by client order index and by an order_index above 2^53 (tx 15)', () => {
    const byClientIndex = signer.signCancelOrder({ marketIndex: 1, index: 176_000_000_001, nonce: 14 });
    expect(byClientIndex.txType).toBe(LIGHTER_TX_TYPE.CANCEL_ORDER);
    expect(JSON.parse(byClientIndex.txInfo)).toMatchObject({ MarketIndex: 1, Index: 176_000_000_001, Nonce: 14 });

    const big = '576460752303423611';
    const byOrderIndex = signer.signCancelOrder({ marketIndex: 1, index: big, nonce: 15 });
    expect(byOrderIndex.txInfo).toContain(`"Index":${big},`);
    const viaBigInt = signer.signCancelOrder({ marketIndex: 1, index: BigInt(big), nonce: 16 });
    expect(viaBigInt.txInfo).toContain(`"Index":${big},`);
  });

  it('signs cancel-all for one market and for every market (tx 16)', () => {
    const oneMarket = signer.signCancelAll({ timeInForce: LIGHTER_CANCEL_ALL_TIME_IN_FORCE.IMMEDIATE, time: 0, marketIndex: 1, nonce: 17 });
    expect(oneMarket.txType).toBe(LIGHTER_TX_TYPE.CANCEL_ALL_ORDERS);
    expect(JSON.parse(oneMarket.txInfo)).toMatchObject({ TimeInForce: 0, Time: 0, L2TxAttributes: { 5: 1 }, Nonce: 17 });

    const everyMarket = signer.signCancelAll({ timeInForce: LIGHTER_CANCEL_ALL_TIME_IN_FORCE.IMMEDIATE, time: 0, nonce: 18 });
    expect(JSON.parse(everyMarket.txInfo)).toMatchObject({ TimeInForce: 0, Time: 0, L2TxAttributes: null });

    expect(() => signer.signCancelAll({
      timeInForce: LIGHTER_CANCEL_ALL_TIME_IN_FORCE.SCHEDULED, time: Date.now() + DAY, marketIndex: 1, nonce: 19,
    })).toThrow(RangeError);
    expect(() => signer.signCancelAll({ timeInForce: LIGHTER_CANCEL_ALL_TIME_IN_FORCE.IMMEDIATE, time: Date.now(), nonce: 19 }))
      .toThrow(RangeError);
  });

  it('signs a leverage update (tx 20)', () => {
    const tx = signer.signUpdateLeverage({ marketIndex: 1, initialMarginFraction: 1000, marginMode: LIGHTER_MARGIN_MODE.CROSS, nonce: 20 });
    expect(tx.txType).toBe(LIGHTER_TX_TYPE.UPDATE_LEVERAGE);
    expect(JSON.parse(tx.txInfo)).toMatchObject({ MarketIndex: 1, InitialMarginFraction: 1000, MarginMode: 0, Nonce: 20 });
  });

  it('creates an auth token for an explicit deadline of at most 8 hours', () => {
    const deadline = Math.floor(Date.now() / 1000) + 6 * 3600;
    const token = signer.createAuthToken(deadline);
    expect(token).toMatch(new RegExp(`^${deadline}:${ACCOUNT}:${KEY_INDEX}:[0-9a-f]{160}$`));
    expect(() => signer.createAuthToken(Math.floor(Date.now() / 1000) - 1)).toThrow(RangeError);
    expect(() => signer.createAuthToken(0)).toThrow(RangeError); // 0 would mean "now + 7 h" in the library
    expect(() => signer.createAuthToken(Math.floor(Date.now() / 1000) + 9 * 3600)).toThrow(RangeError);
  });

  it('rejects values koffi would silently wrap before they reach the library (spec §6.3)', () => {
    const wraps: Array<[string, () => unknown]> = [
      ['price 4294967396 -> 100', () => signer.signCreateOrder({ ...limitOrder({ price: 4294967396 }), nonce: 30 })],
      ['price -1 -> 4294967295', () => signer.signCreateOrder({ ...limitOrder({ price: -1 }), nonce: 30 })],
      ['price 100.7 -> 100', () => signer.signCreateOrder({ ...limitOrder({ price: 100.7 }), nonce: 30 })],
      ['trigger 2^32 -> 0', () => signer.signCreateOrder({ ...limitOrder({ triggerPrice: 2 ** 32 }), nonce: 30 })],
      ['baseAmount 2^48', () => signer.signCreateOrder({ ...limitOrder({ baseAmount: 2 ** 48 }), nonce: 30 })],
      ['baseAmount -1', () => signer.signCreateOrder({ ...limitOrder({ baseAmount: -1 }), nonce: 30 })],
      ['clientOrderIndex 2^48', () => signer.signCreateOrder({ ...limitOrder({ clientOrderIndex: 2 ** 48 }), nonce: 30 })],
      ['orderExpiry -1', () => signer.signCreateOrder({ ...limitOrder({ orderExpiry: -1 }), nonce: 30 })],
      ['nonce -1 (library fetch)', () => signer.signCreateOrder({ ...limitOrder(), nonce: -1 })],
      ['nonce 1.5', () => signer.signCancelOrder({ marketIndex: 1, index: 5, nonce: 1.5 })],
      ['isAsk as a number', () => signer.signCreateOrder({ ...limitOrder({ isAsk: 1 as unknown as boolean }), nonce: 30 })],
      ['IMF 66536 -> 1000 (uint16)', () => signer.signUpdateLeverage({ marketIndex: 1, initialMarginFraction: 66536, marginMode: 0, nonce: 30 })],
      ['IMF 0', () => signer.signUpdateLeverage({ marketIndex: 1, initialMarginFraction: 0, marginMode: 0, nonce: 30 })],
      ['margin mode 2', () => signer.signUpdateLeverage({ marketIndex: 1, initialMarginFraction: 1000, marginMode: 2 as 0, nonce: 30 })],
      ['cancel index 2^64 -> 0', () => signer.signCancelOrder({ marketIndex: 1, index: BigInt(2) ** BigInt(64), nonce: 30 })],
      ['cancel index as an unsafe number', () => signer.signCancelOrder({ marketIndex: 1, index: Number('576460752303423611'), nonce: 30 })],
      ['market 255 on cancel', () => signer.signCancelOrder({ marketIndex: 255, index: 5, nonce: 30 })],
      ['auth deadline 1.5', () => signer.createAuthToken(Math.floor(Date.now() / 1000) + 60.5)],
    ];
    for (const [label, attempt] of wraps) {
      let thrown: unknown = null;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      expect([label, thrown instanceof RangeError]).toEqual([label, true]);
    }
  });

  it('allows one network per process (spec §8 risk 24)', () => {
    expect(() => loadLighterSigner({
      chainId: 304, accountIndex: ACCOUNT, apiKeyIndex: KEY_INDEX, apiKeyPrivateKey: THROWAWAY_KEY, libraryPath: signerPath!,
    })).toThrow(/one network per process/);
  });

  it('reuses the registered key and refuses a different key for the same account and index', () => {
    const again = loadLighterSigner({
      chainId: TESTNET_CHAIN, accountIndex: ACCOUNT, apiKeyIndex: KEY_INDEX, apiKeyPrivateKey: THROWAWAY_KEY.slice(2).toUpperCase(), libraryPath: signerPath!,
    });
    expect(again.signCancelOrder({ marketIndex: 1, index: 5, nonce: 40 }).txType).toBe(LIGHTER_TX_TYPE.CANCEL_ORDER);

    const otherKey = `0x${THROWAWAY_KEY.slice(2, 80)}${'00'}`;
    expect(() => loadLighterSigner({
      chainId: TESTNET_CHAIN, accountIndex: ACCOUNT, apiKeyIndex: KEY_INDEX, apiKeyPrivateKey: otherKey, libraryPath: signerPath!,
    })).toThrow(/different private key/);
  });

  it('signs for a second key index on the same network', () => {
    const second = loadLighterSigner({
      chainId: TESTNET_CHAIN, accountIndex: ACCOUNT, apiKeyIndex: 4, apiKeyPrivateKey: THROWAWAY_KEY, libraryPath: signerPath!,
    });
    const info = JSON.parse(second.signCancelOrder({ marketIndex: 1, index: 5, nonce: 1 }).txInfo);
    expect(info).toMatchObject({ AccountIndex: ACCOUNT, ApiKeyIndex: 4, Nonce: 1 });
  });
});
