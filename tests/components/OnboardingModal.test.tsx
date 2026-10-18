import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { toast } from 'sonner';
import { OnboardingModal } from '@/components/onboarding/OnboardingModal';
import { useConfig } from '@/components/ConfigProvider';
import { useOnboarding } from '@/components/onboarding/OnboardingProvider';
import type { Config } from '@/lib/types';

// The exchange step of the setup wizard saves the config it collected. The server refuses a live config the bot would
// not start with (POST /api/config, see tests/api/config-route.test.ts) and says why: the wizard has to show that
// instead of moving on or failing silently.

jest.mock('sonner', () => ({
  toast: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));
jest.mock('@/components/ConfigProvider', () => ({ useConfig: jest.fn() }));
jest.mock('@/components/onboarding/OnboardingProvider', () => ({ useOnboarding: jest.fn() }));

const API_KEY = 'k'.repeat(64);
const SECRET_KEY = 's'.repeat(64);
const PRIVATE_KEY = 'a1'.repeat(40);
const PUBLIC_KEY = 'b2'.repeat(40);

const CONFIG: Config = {
  api: { apiKey: '', secretKey: '' },
  symbols: {},
  global: {
    riskPercent: 5,
    paperMode: true,
    positionMode: 'ONE_WAY',
    exchange: 'aster',
    liquidationSource: 'aster',
    server: { dashboardPassword: '', dashboardPort: 3000, websocketPort: 8080, useRemoteWebSocket: false, websocketHost: null },
  },
  venues: { lighter: { profile: 'testnet' } },
  version: '1.3.0',
};

const STEPS = ['welcome', 'password-setup', 'api-setup', 'symbol-config', 'dashboard-tour', 'completion'].map((id) => ({
  id, title: id, description: id, completed: false,
}));

const SERVER_REASON = 'Failed to save config: 400 Bad Request - Config validation failed: API keys must be 64 characters when not in paper mode';

let updateConfig: jest.Mock;
let nextStep: jest.Mock;
let completeStep: jest.Mock;

function renderModal(config: Config = CONFIG) {
  updateConfig = jest.fn(async () => {});
  nextStep = jest.fn();
  completeStep = jest.fn();
  (useConfig as jest.Mock).mockReturnValue({ config, loading: false, updateConfig, reloadConfig: jest.fn() });
  (useOnboarding as jest.Mock).mockReturnValue({
    isOnboarding: true,
    currentStep: 2,
    steps: STEPS,
    nextStep,
    previousStep: jest.fn(),
    skipOnboarding: jest.fn(),
    completeStep,
    setShowTutorial: jest.fn(),
  });
  return render(<OnboardingModal />);
}

function openKeysTab() {
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Enter Keys' }), { button: 0, ctrlKey: false });
}

const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('OnboardingModal: saving the exchange step', () => {
  it('shows why the server refused the keys, stays on the step and moves on once they are accepted', async () => {
    renderModal();
    openKeysTab();
    change('API Key', 'not-sixty-four-characters');
    change('Secret Key', SECRET_KEY);
    updateConfig.mockRejectedValueOnce(new Error(SERVER_REASON));

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Could not save your exchange settings',
      { description: SERVER_REASON }
    ));
    expect(nextStep).not.toHaveBeenCalled();
    expect(completeStep).not.toHaveBeenCalled();
    // The step is still there with what was typed
    expect(screen.getByLabelText('API Key')).toHaveValue('not-sixty-four-characters');
    // The keys are not part of what is said
    expect(JSON.stringify((toast.error as jest.Mock).mock.calls)).not.toContain(SECRET_KEY);

    change('API Key', API_KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(nextStep).toHaveBeenCalledTimes(1));
    expect(completeStep).toHaveBeenCalledWith('api-setup');
    expect(updateConfig).toHaveBeenCalledTimes(2);
    expect(updateConfig.mock.calls[1][0]).toMatchObject({
      api: { apiKey: API_KEY, secretKey: SECRET_KEY },
      global: { paperMode: false, exchange: 'aster' },
    });
  });

  it('copes with an error that is not an Error', async () => {
    renderModal();
    openKeysTab();
    change('API Key', API_KEY);
    change('Secret Key', SECRET_KEY);
    updateConfig.mockRejectedValueOnce('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save your exchange settings', { description: 'Please try again' }));
    expect(nextStep).not.toHaveBeenCalled();
  });

  it('saves paper mode without keys and moves on', async () => {
    renderModal();
    openKeysTab();
    fireEvent.click(screen.getByRole('button', { name: 'Use Paper Mode' }));
    await waitFor(() => expect(nextStep).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig.mock.calls[0][0]).toMatchObject({ api: { apiKey: '', secretKey: '' }, global: { paperMode: true, exchange: 'aster' } });
  });

  it('saves Lighter in paper mode', async () => {
    renderModal({ ...CONFIG, global: { ...CONFIG.global, exchange: 'lighter' } });
    openKeysTab();
    fireEvent.click(screen.getByRole('button', { name: 'Use Paper Mode' }));
    await waitFor(() => expect(nextStep).toHaveBeenCalledTimes(1));
    expect(updateConfig.mock.calls[0][0]).toMatchObject({ global: { paperMode: true, exchange: 'lighter', positionMode: 'ONE_WAY' } });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows the refusal of a live Lighter config as well', async () => {
    renderModal({ ...CONFIG, global: { ...CONFIG.global, exchange: 'lighter' } });
    openKeysTab();
    change('Account index', '12345');
    change('API key index', '3');
    change('API private key', PRIVATE_KEY);
    change('API public key', PUBLIC_KEY);
    updateConfig.mockRejectedValueOnce(new Error('Failed to save config: 400 Bad Request - Config validation failed: Lighter credentials are required when not in paper mode: API key index is missing'));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Could not save your exchange settings',
      { description: expect.stringContaining('Lighter credentials are required when not in paper mode') }
    ));
    expect(JSON.stringify((toast.error as jest.Mock).mock.calls)).not.toContain(PRIVATE_KEY);
    expect(nextStep).not.toHaveBeenCalled();
  });
});
