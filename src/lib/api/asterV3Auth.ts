import { SigningKey, TypedDataEncoder, computeAddress } from 'ethers';

// Aster V3 ("Pro API") authentication: requests are signed with an API (agent) wallet using EIP-712
// instead of an HMAC secret. See https://github.com/asterdex/api-docs (V3 futures, "Authentication").

export interface AsterV3Credentials {
  user: string;              // Main account wallet address
  signer: string;            // API wallet (agent) address
  signerPrivateKey: string;  // API wallet private key
}

export const ASTER_V3_DOMAIN = {
  name: 'AsterSignTransaction',
  version: '1',
  chainId: 1666,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

const MESSAGE_TYPES = {
  Message: [{ name: 'msg', type: 'string' }],
};

type ParamValue = string | number | boolean;

let lastNonce = 0;

// Microsecond timestamp, strictly increasing within this process (Aster rejects reused nonces
// and only accepts ones within 60 seconds of server time)
export function nextNonce(nowMs: number = Date.now()): string {
  const candidate = nowMs * 1000;
  lastNonce = candidate > lastNonce ? candidate : lastNonce + 1;
  return String(lastNonce);
}

// Parameters sorted by key (ASCII order) and joined as key=value pairs
export function buildV3Message(params: Record<string, ParamValue>): string {
  return Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
}

function normalizePrivateKey(privateKey: string): string {
  const trimmed = privateKey.trim();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

export function signV3Message(message: string, privateKey: string): string {
  const digest = TypedDataEncoder.hash(ASTER_V3_DOMAIN, MESSAGE_TYPES, { msg: message });
  return new SigningKey(normalizePrivateKey(privateKey)).sign(digest).serialized;
}

// Business params plus timestamp, nonce, user and signer, with the signature over all of them
export function buildV3SignedParams(
  params: Record<string, ParamValue | undefined>,
  credentials: AsterV3Credentials,
  nowMs: number = Date.now()
): Record<string, string> {
  const signedParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      signedParams[key] = String(value);
    }
  }
  signedParams.timestamp = String(nowMs);
  signedParams.nonce = nextNonce(nowMs);
  signedParams.user = credentials.user;
  signedParams.signer = credentials.signer;

  return {
    ...signedParams,
    signature: signV3Message(buildV3Message(signedParams), credentials.signerPrivateKey),
  };
}

// True when the private key belongs to the configured API wallet address
export function signerMatchesPrivateKey(credentials: AsterV3Credentials): boolean {
  try {
    return computeAddress(normalizePrivateKey(credentials.signerPrivateKey)).toLowerCase() ===
      credentials.signer.trim().toLowerCase();
  } catch {
    return false;
  }
}
