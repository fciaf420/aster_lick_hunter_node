import { ConfigMigration } from './types';
import { DEFAULT_CONFIG_VERSION, DEFAULT_LIGHTER_VENUE_SETTINGS } from './defaults';

const migrations: ConfigMigration[] = [
  // Migration from v0.9.0 to v1.0.0
  {
    fromVersion: '0.9.0',
    toVersion: '1.0.0',
    migrate: (config: any) => {
      // Add version field if missing
      if (!config.version) {
        config.version = '1.0.0';
      }

      // Migrate legacy volumeThresholdUSDT to separate long/short thresholds
      if (config.symbols) {
        Object.keys(config.symbols).forEach(symbol => {
          const symbolConfig = config.symbols[symbol];
          if (symbolConfig.volumeThresholdUSDT !== undefined &&
              symbolConfig.longVolumeThresholdUSDT === undefined &&
              symbolConfig.shortVolumeThresholdUSDT === undefined) {
            symbolConfig.longVolumeThresholdUSDT = symbolConfig.volumeThresholdUSDT;
            symbolConfig.shortVolumeThresholdUSDT = symbolConfig.volumeThresholdUSDT;
            delete symbolConfig.volumeThresholdUSDT;
          }
        });
      }

      // Add default maxPositionMarginUSDT if missing
      if (config.symbols) {
        Object.keys(config.symbols).forEach(symbol => {
          const symbolConfig = config.symbols[symbol];
          if (symbolConfig.maxPositionMarginUSDT === undefined) {
            const tradeValue = (symbolConfig.tradeSize || 1) * 1000;
            symbolConfig.maxPositionMarginUSDT = tradeValue * (symbolConfig.leverage || 10);
          }
        });
      }

      // Add default maxOpenPositions if missing
      if (config.global && config.global.maxOpenPositions === undefined) {
        config.global.maxOpenPositions = 10;
      }

      return config;
    }
  },
  // Migration from v1.0.0 to v1.1.0 - Add support for separate long/short trade sizes
  {
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    migrate: (config: any) => {
      // Update version
      config.version = '1.1.0';

      // No structural changes needed for v1.1.0
      // The longTradeSize and shortTradeSize fields are optional
      // When not present, the bot falls back to using tradeSize
      // This ensures backward compatibility

      console.log('Migrated to v1.1.0: Added support for separate long/short trade sizes');

      return config;
    }
  },
  // Migration from v1.1.0 to v1.2.0 - Add trading venue and liquidation source selection
  {
    fromVersion: '1.1.0',
    toVersion: '1.2.0',
    migrate: (config: any) => {
      config.version = '1.2.0';

      // Existing configs keep trading on Aster with Aster liquidations
      if (config.global) {
        config.global.exchange = config.global.exchange ?? 'aster';
        config.global.liquidationSource = config.global.liquidationSource ?? 'aster';
      }

      console.log('Migrated to v1.2.0: Added trading venue and liquidation source selection');

      return config;
    }
  },
  // Migration from v1.2.0 to v1.3.0 - Lighter venue settings (network, shadow mode, SL/TP slippage, tx rate)
  {
    fromVersion: '1.2.0',
    toVersion: '1.3.0',
    migrate: (config: any) => {
      config.version = '1.3.0';

      const venues = config.venues && typeof config.venues === 'object' && !Array.isArray(config.venues) ? config.venues : {};
      const lighter = venues.lighter && typeof venues.lighter === 'object' && !Array.isArray(venues.lighter) ? { ...venues.lighter } : {};

      // The first catalog listing named the key fields apiPrivateKey / apiPublicKey
      if (lighter.apiKeyPrivateKey === undefined && lighter.apiPrivateKey !== undefined) lighter.apiKeyPrivateKey = lighter.apiPrivateKey;
      if (lighter.apiKeyPublicKey === undefined && lighter.apiPublicKey !== undefined) lighter.apiKeyPublicKey = lighter.apiPublicKey;
      delete lighter.apiPrivateKey;
      delete lighter.apiPublicKey;

      // Defaults never overwrite a value the user set; credentials have no default
      config.venues = { ...venues, lighter: { ...DEFAULT_LIGHTER_VENUE_SETTINGS, ...lighter } };

      console.log('Migrated to v1.3.0: Added Lighter settings (testnet, liquidation feed in shadow mode)');

      return config;
    }
  }
];

export function migrateConfig(config: any, targetVersion: string = DEFAULT_CONFIG_VERSION): any {
  let currentConfig = { ...config };
  let currentVersion = config.version || '0.9.0'; // Assume 0.9.0 for configs without version

  // Apply migrations sequentially
  while (currentVersion !== targetVersion) {
    const migration = migrations.find(m => m.fromVersion === currentVersion);
    if (!migration) {
      console.log(`No migration path from version ${currentVersion} to ${targetVersion}`);
      break;
    }

    console.log(`Migrating config from ${migration.fromVersion} to ${migration.toVersion}`);
    currentConfig = migration.migrate(currentConfig);
    currentVersion = migration.toVersion;
  }

  currentConfig.version = targetVersion;
  return currentConfig;
}

export function needsMigration(config: any): boolean {
  const currentVersion = config.version || '0.9.0';
  return currentVersion !== DEFAULT_CONFIG_VERSION;
}

export function addMissingFields(userConfig: any, defaultConfig: any): any {
  const result = { ...userConfig };

  // Add missing top-level fields
  for (const key in defaultConfig) {
    if (!(key in result) && key !== 'api') {
      result[key] = defaultConfig[key];
      console.log(`Added missing field: ${key}`);
    }
  }

  // Add missing symbol configs from defaults
  if (defaultConfig.symbols && result.symbols) {
    for (const symbol in defaultConfig.symbols) {
      if (!(symbol in result.symbols)) {
        // Don't auto-add symbols, only merge existing ones
        continue;
      }

      // Add missing fields to existing symbols
      const userSymbol = result.symbols[symbol];
      const defaultSymbol = defaultConfig.symbols[symbol];

      for (const field in defaultSymbol) {
        if (!(field in userSymbol)) {
          userSymbol[field] = defaultSymbol[field];
          console.log(`Added missing field to ${symbol}: ${field}`);
        }
      }
    }
  }

  // Add missing global config fields
  if (defaultConfig.global && result.global) {
    for (const field in defaultConfig.global) {
      if (!(field in result.global)) {
        result.global[field] = defaultConfig.global[field];
        console.log(`Added missing global field: ${field}`);
      } else if (field === 'server' && typeof defaultConfig.global[field] === 'object' && typeof result.global[field] === 'object') {
        // Merge server config nested fields
        const defaultServer = defaultConfig.global.server;
        const userServer = result.global.server || {};
        result.global.server = { ...defaultServer, ...userServer };

        // Log any new server fields that were added
        for (const serverField in defaultServer) {
          if (!(serverField in userServer)) {
            console.log(`Added missing server field: ${serverField}`);
          }
        }
      }
    }
  }

  // Ensure version is set
  if (!result.version) {
    result.version = DEFAULT_CONFIG_VERSION;
  }

  return result;
}