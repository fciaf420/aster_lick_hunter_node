#!/usr/bin/env tsx

import {
  TestSummary,
  logSection,
  log,
  colors,
  createMockConfig,
  assert,
  assertEqual,
  mockExchangeHttp,
  finishTests
} from '../utils/test-helpers';
import {
  createExchangeAdapter,
  getConfiguredVenue,
  resolveLiquidationSource
} from '../../src/lib/exchange/registry';
import { VENUE_CATALOG, LIQUIDATION_SOURCE_CATALOG } from '../../src/lib/exchange/catalog';
import { VENUE_IDS, LIQUIDATION_SOURCE_IDS } from '../../src/lib/exchange/types';
import { configSchema } from '../../src/lib/config/types';
import { migrateConfig } from '../../src/lib/config/migrator';
import { DEFAULT_CONFIG, DEFAULT_CONFIG_VERSION } from '../../src/lib/config/defaults';

async function testVenueSelection() {
  logSection('Testing Venue Selection');
  const summary = new TestSummary();

  await summary.run('Defaults to Aster when no venue is configured', async () => {
    const config = createMockConfig();
    delete (config.global as any).exchange;
    assertEqual(getConfiguredVenue(config), 'aster', 'Default venue should be aster');
    const adapter = createExchangeAdapter(config);
    assertEqual(adapter.id, 'aster', 'Adapter should be the Aster adapter');
    assert(adapter.hasCredentials(), 'Mock config has Aster credentials');
  });

  await summary.run('Reports missing credentials', async () => {
    const config = createMockConfig();
    config.api.apiKey = '';
    config.api.secretKey = '';
    assert(!createExchangeAdapter(config).hasCredentials(), 'Empty keys should report no credentials');
  });

  await summary.run('Refuses venues that are not implemented yet', async () => {
    for (const entry of VENUE_CATALOG.filter(v => v.status !== 'available')) {
      const config = createMockConfig();
      (config.global as any).exchange = entry.id;
      let threw = false;
      try {
        createExchangeAdapter(config);
      } catch (error) {
        threw = error instanceof Error && error.message.includes('not supported yet');
      }
      assert(threw, `${entry.name} should be refused`);
    }
  });

  await summary.run('Refuses liquidation sources that are not implemented yet', async () => {
    const config = createMockConfig();
    assertEqual(resolveLiquidationSource(config), 'aster', 'Default source should be aster');
    for (const entry of LIQUIDATION_SOURCE_CATALOG.filter(s => s.status !== 'available')) {
      (config.global as any).liquidationSource = entry.id;
      let threw = false;
      try {
        resolveLiquidationSource(config);
      } catch {
        threw = true;
      }
      assert(threw, `${entry.name} should be refused`);
    }
  });

  await summary.run('Catalog lists every known venue and source', async () => {
    assertEqual(VENUE_CATALOG.map(v => v.id).sort().join(','), [...VENUE_IDS].sort().join(','), 'Venue catalog should match VENUE_IDS');
    assertEqual(
      LIQUIDATION_SOURCE_CATALOG.map(s => s.id).sort().join(','),
      [...LIQUIDATION_SOURCE_IDS].sort().join(','),
      'Source catalog should match LIQUIDATION_SOURCE_IDS'
    );
  });

  summary.print();
}

async function testConfig() {
  logSection('Testing Venue Config');
  const summary = new TestSummary();

  await summary.run('Schema keeps venue fields and rejects unknown venues', async () => {
    const config: any = structuredClone(DEFAULT_CONFIG);
    config.global.exchange = 'aster';
    config.global.liquidationSource = 'aster';
    config.venues = { hyperliquid: { accountAddress: '0xabc' } };
    const parsed = configSchema.parse(config);
    assertEqual(parsed.global.exchange, 'aster', 'exchange should be kept');
    assertEqual(parsed.global.liquidationSource, 'aster', 'liquidationSource should be kept');
    assertEqual(parsed.venues?.hyperliquid?.accountAddress, '0xabc', 'venue credentials should be kept');

    config.global.exchange = 'not-a-venue';
    assert(!configSchema.safeParse(config).success, 'Unknown venue should fail validation');
  });

  await summary.run('Migrates 1.1.0 configs to Aster defaults', async () => {
    const config: any = createMockConfig();
    config.version = '1.1.0';
    delete config.global.exchange;
    delete config.global.liquidationSource;
    const migrated = migrateConfig(config);
    assertEqual(migrated.version, DEFAULT_CONFIG_VERSION, 'Should reach the current version');
    assertEqual(migrated.global.exchange, 'aster', 'Existing configs keep trading on Aster');
    assertEqual(migrated.global.liquidationSource, 'aster', 'Existing configs keep Aster liquidations');
  });

  summary.print();
}

async function testAsterAdapterRequests() {
  logSection('Testing Aster Adapter Requests');
  const summary = new TestSummary();

  const requests: string[] = [];
  mockExchangeHttp((config) => {
    const url = new URL(config.url!, 'https://fapi.asterdex.com');
    requests.push(`${config.method?.toUpperCase()} ${url.pathname}`);
    if (url.pathname === '/fapi/v1/positionSide/dual') return { dualSidePosition: true };
    if (url.pathname === '/fapi/v1/premiumIndex') return { symbol: 'BTCUSDT', markPrice: '50000' };
    if (url.pathname === '/fapi/v1/order') return { orderId: 1, symbol: 'BTCUSDT', status: 'NEW' };
    return [];
  });

  await summary.run('Delegates to the existing Aster endpoints', async () => {
    const adapter = createExchangeAdapter(createMockConfig());
    assertEqual(await adapter.getHedgeMode(), true, 'Hedge mode should come from positionSide/dual');
    await adapter.getPositions();
    await adapter.getOpenOrders('BTCUSDT');
    await adapter.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01 });
    await adapter.cancelOrder('BTCUSDT', 1);

    const expected = [
      'GET /fapi/v1/positionSide/dual',
      'GET /fapi/v2/positionRisk',
      'GET /fapi/v1/openOrders',
      'GET /fapi/v1/premiumIndex',
      'POST /fapi/v1/order',
      'DELETE /fapi/v1/order'
    ];
    assertEqual(requests.join('\n'), expected.join('\n'), `Unexpected requests:\n${requests.join('\n')}`);
    log(`  ${requests.length} requests matched`, colors.gray);
  });

  summary.print();
}

async function main() {
  log('🧪 EXCHANGE REGISTRY TEST SUITE', colors.cyan + colors.bold);
  log('='.repeat(60), colors.cyan);

  await testVenueSelection();
  await testConfig();
  await testAsterAdapterRequests();

  logSection('✨ All Exchange Registry Tests Complete');
  finishTests();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
