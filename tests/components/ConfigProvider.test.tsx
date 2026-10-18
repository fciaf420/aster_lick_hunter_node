import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ConfigProvider, { useConfig } from '@/components/ConfigProvider';
import type { Config } from '@/lib/types';

// The login page shows no onboarding: only the provider's own save is under test
jest.mock('next/navigation', () => ({ usePathname: () => '/login' }));

const CONFIG: Config = {
  api: { apiKey: '', secretKey: '' },
  symbols: {},
  global: { riskPercent: 5, paperMode: false, exchange: 'aster' },
};

function Saver({ onError }: { onError: (message: string) => void }) {
  const { config, updateConfig } = useConfig();
  return (
    <button type="button" disabled={!config} onClick={() => updateConfig(CONFIG).catch((error: Error) => onError(error.message))}>
      save
    </button>
  );
}

function respond(status: number, statusText: string, body: unknown) {
  (global as any).fetch = jest.fn(async (_url: string, init?: { method?: string }) => ({
    ok: init?.method === 'POST' ? status < 400 : true,
    status: init?.method === 'POST' ? status : 200,
    statusText: init?.method === 'POST' ? statusText : 'OK',
    json: async () => (init?.method === 'POST' ? body : CONFIG),
  }));
}

async function saveAndGetError(): Promise<string> {
  const onError = jest.fn();
  render(<ConfigProvider><Saver onError={onError} /></ConfigProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'save' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'save' }));
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  return onError.mock.calls[0][0];
}

describe('ConfigProvider.updateConfig', () => {
  it('says why the server refused the config', async () => {
    respond(400, 'Bad Request', { error: 'Config validation failed', details: 'API keys are required when not in paper mode' });
    expect(await saveAndGetError()).toBe(
      'Failed to save config: 400 Bad Request - Config validation failed: API keys are required when not in paper mode'
    );
  });

  it('keeps the old message when the server gives no details', async () => {
    respond(500, 'Internal Server Error', { error: 'Failed to save config' });
    expect(await saveAndGetError()).toBe('Failed to save config: 500 Internal Server Error - Failed to save config');
  });

  it('copes with an answer that is not JSON', async () => {
    (global as any).fetch = jest.fn(async (_url: string, init?: { method?: string }) => ({
      ok: init?.method !== 'POST',
      status: init?.method === 'POST' ? 502 : 200,
      statusText: init?.method === 'POST' ? 'Bad Gateway' : 'OK',
      json: async () => {
        if (init?.method === 'POST') throw new SyntaxError('Unexpected token <');
        return CONFIG;
      },
    }));
    expect(await saveAndGetError()).toBe('Failed to save config: 502 Bad Gateway');
  });
});
