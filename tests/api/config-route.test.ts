/**
 * @jest-environment node
 */
import { GET, POST } from '@/app/api/config/route';
import { configLoader } from '@/lib/config/configLoader';
import { DEFAULT_CONFIG } from '@/lib/config/defaults';

// POST /api/config must not write a config that the bot would refuse to load (configLoader applies the same checks,
// see tests/lib/config/live-mode.test.ts). The loader is mocked: nothing here touches a config file.
jest.mock('@/lib/config/configLoader', () => ({
  configLoader: { saveConfig: jest.fn(async () => {}), getConfig: jest.fn(), loadConfig: jest.fn() },
}));

const saveConfig = configLoader.saveConfig as jest.Mock;

const API_KEY = 'k'.repeat(64);
const SECRET_KEY = 's'.repeat(64);
const MAIN_PRIVATE_KEY = 'a1'.repeat(40);
const MAIN_PUBLIC_KEY = 'b2'.repeat(40);
const SHORT_PRIVATE_KEY = 'c3'.repeat(40);
const SHORT_PUBLIC_KEY = 'd4'.repeat(40);

const MAIN_ACCOUNT = { accountIndex: 12345, apiKeyIndex: 3, apiKeyPrivateKey: MAIN_PRIVATE_KEY, apiKeyPublicKey: MAIN_PUBLIC_KEY };
const SHORT_ACCOUNT = { accountIndex: 23456, apiKeyIndex: 4, apiKeyPrivateKey: SHORT_PRIVATE_KEY, apiKeyPublicKey: SHORT_PUBLIC_KEY };

function config(change: (draft: any) => void = () => {}): any {
  const draft = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  change(draft);
  return draft;
}

async function post(body: unknown) {
  const response = await POST(new Request('http://localhost/api/config', { method: 'POST', body: JSON.stringify(body) }));
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
}

const hedgeLighter = (shortAccount: unknown) => (draft: any) => {
  draft.global = { ...draft.global, paperMode: false, exchange: 'lighter', positionMode: 'HEDGE' };
  draft.venues.lighter = { ...draft.venues.lighter, ...MAIN_ACCOUNT, hedge: { enabled: true, shortAccount } };
};

describe('POST /api/config: configs the bot would not load', () => {
  it('refuses a live Lighter hedge config with an incomplete short account, and writes nothing', async () => {
    const result = await post(config(hedgeLighter({ accountIndex: 23456, apiKeyPrivateKey: SHORT_PRIVATE_KEY })));
    expect(result.status).toBe(400);
    expect(result.json).toEqual({
      error: 'Config validation failed',
      details:
        'Lighter hedge mode needs a complete short account when not in paper mode: short account API key index is missing; ' +
        'short account API public key is missing. Fill it in or turn hedge mode off.',
    });
    expect(saveConfig).not.toHaveBeenCalled();
    // The answer names what is missing; it holds none of the keys that were sent
    for (const secret of [MAIN_PRIVATE_KEY, MAIN_PUBLIC_KEY, SHORT_PRIVATE_KEY]) expect(result.text).not.toContain(secret);
  });

  it('saves the same config in paper mode, and once the short account is complete', async () => {
    const incomplete = config(hedgeLighter({ accountIndex: 23456 }));
    incomplete.global.paperMode = true;
    expect((await post(incomplete)).status).toBe(200);
    expect(saveConfig).toHaveBeenCalledTimes(1);

    expect((await post(config(hedgeLighter(SHORT_ACCOUNT)))).status).toBe(200);
    expect(saveConfig).toHaveBeenCalledTimes(2);
  });

  it('refuses a live Lighter config without credentials', async () => {
    const result = await post(config((draft) => { draft.global.paperMode = false; draft.global.exchange = 'lighter'; }));
    expect(result.status).toBe(400);
    expect(result.json.details).toBe(
      'Lighter credentials are required when not in paper mode: account index is missing; API key index is missing; ' +
      'API private key is missing; API public key is missing'
    );
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('refuses live Aster without keys, and with keys of the wrong length, without echoing them', async () => {
    const live = (apiKey: string, secretKey: string) => config((draft) => { draft.global.paperMode = false; draft.api = { apiKey, secretKey }; });

    const missing = await post(live('', ''));
    expect(missing.status).toBe(400);
    expect(missing.json.details).toBe('API keys are required when not in paper mode');

    const short = await post(live('short-api-key-value', SECRET_KEY));
    expect(short.status).toBe(400);
    expect(short.json.details).toBe('API keys must be 64 characters when not in paper mode');
    expect(short.text).not.toContain('short-api-key-value');
    expect(short.text).not.toContain(SECRET_KEY);
    expect(saveConfig).not.toHaveBeenCalled();

    expect((await post(live(API_KEY, SECRET_KEY))).status).toBe(200);
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps saving a paper-mode config without keys (onboarding, the default config)', async () => {
    expect((await post(config())).status).toBe(200);
    expect((await post(config((draft) => { delete draft.api; draft.global.paperMode = true; }))).status).toBe(200);
    expect(saveConfig).toHaveBeenCalledTimes(2);
    expect(saveConfig.mock.calls[1][0].api).toEqual({ apiKey: '', secretKey: '' });
  });

  it('still answers the schema errors first', async () => {
    const result = await post(config((draft) => { draft.global.paperMode = false; draft.symbols.BTCUSDT.leverage = 500; }));
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('Config validation failed');
    expect(result.json.details).toContain('symbols.BTCUSDT.leverage');
  });

  it('still serves the config it loaded', async () => {
    (configLoader.getConfig as jest.Mock).mockReturnValueOnce({ marker: true });
    expect(await (await GET()).json()).toEqual({ marker: true });
  });
});
