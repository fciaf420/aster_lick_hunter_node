/**
 * @jest-environment node
 */
import { Wallet, verifyTypedData } from 'ethers';
import {
  ASTER_V3_DOMAIN,
  buildV3Message,
  buildV3SignedParams,
  nextNonce,
  signerMatchesPrivateKey,
} from '../../src/lib/api/asterV3Auth';

const MESSAGE_TYPES = { Message: [{ name: 'msg', type: 'string' }] };

describe('Aster V3 auth', () => {
  const agent = Wallet.createRandom();
  const credentials = {
    user: '0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e',
    signer: agent.address,
    signerPrivateKey: agent.privateKey,
  };

  it('sorts parameters by key and joins them as key=value', () => {
    expect(buildV3Message({ symbol: 'BTCUSDT', side: 'BUY', quantity: '0.01', nonce: '1' }))
      .toBe('nonce=1&quantity=0.01&side=BUY&symbol=BTCUSDT');
  });

  it('produces microsecond nonces that always increase', () => {
    const now = 1_760_000_000_000;
    const first = Number(nextNonce(now));
    const second = Number(nextNonce(now));
    expect(first).toBeGreaterThanOrEqual(now * 1000);
    expect(second).toBeGreaterThan(first);
    expect(Number(nextNonce(now - 5))).toBeGreaterThan(second);
  });

  it('adds auth fields and an EIP-712 signature from the API wallet', () => {
    const now = 1_760_000_000_000;
    const signed = buildV3SignedParams(
      { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.01, price: undefined },
      credentials,
      now
    );

    expect(signed).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: '0.01',
      timestamp: String(now),
      user: credentials.user,
      signer: credentials.signer,
    });
    expect(signed).not.toHaveProperty('price');
    expect(signed.nonce).toMatch(/^\d+$/);

    const { signature, ...signedFields } = signed;
    const recovered = verifyTypedData(ASTER_V3_DOMAIN, MESSAGE_TYPES, { msg: buildV3Message(signedFields) }, signature);
    expect(recovered).toBe(agent.address);
  });

  it('checks that the private key belongs to the API wallet', () => {
    expect(signerMatchesPrivateKey(credentials)).toBe(true);
    expect(signerMatchesPrivateKey({ ...credentials, signerPrivateKey: credentials.signerPrivateKey.slice(2) })).toBe(true);
    expect(signerMatchesPrivateKey({ ...credentials, signer: Wallet.createRandom().address })).toBe(false);
    expect(signerMatchesPrivateKey({ ...credentials, signerPrivateKey: 'not-a-key' })).toBe(false);
  });
});
