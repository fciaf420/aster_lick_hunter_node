import axios from 'axios';
import type { ApiCredentials } from '../../types';
import { buildSignedQuery } from '../../api/auth';
import { ASTER_REST_BASE_URL } from './constants';

// Requests sent straight to Aster with plain axios, outside the shared rate-limit queue.
// The position manager's sync, price checks and listenKey calls have always gone this way,
// so they stay off the queue. Authentication is the V1 scheme (API key header + HMAC signature
// from auth.ts); src/lib/api uses the same helpers, so a V3 agent-wallet signer replaces both.
export class AsterDirectTransport {
  constructor(private readonly getCredentials: () => ApiCredentials) {}

  private apiKeyHeaders() {
    return { 'X-MBX-APIKEY': this.getCredentials().apiKey };
  }

  async signedGet<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const queryString = buildSignedQuery(params, this.getCredentials());
    const response = await axios.get(`${ASTER_REST_BASE_URL}${path}?${queryString}`, {
      headers: this.apiKeyHeaders()
    });
    return response.data;
  }

  // `pathWithQuery` is sent as given (callers pass unencoded symbols, as before)
  async publicGet<T>(pathWithQuery: string): Promise<T> {
    const response = await axios.get(`${ASTER_REST_BASE_URL}${pathWithQuery}`);
    return response.data;
  }

  // listenKey endpoints only need the API key header, no signature
  async createListenKey(): Promise<string> {
    const response = await axios.post(`${ASTER_REST_BASE_URL}/fapi/v1/listenKey`, null, { headers: this.apiKeyHeaders() });
    return response.data.listenKey;
  }

  async keepAliveListenKey(): Promise<void> {
    await axios.put(`${ASTER_REST_BASE_URL}/fapi/v1/listenKey`, null, { headers: this.apiKeyHeaders() });
  }

  async closeListenKey(): Promise<void> {
    await axios.delete(`${ASTER_REST_BASE_URL}/fapi/v1/listenKey`, { headers: this.apiKeyHeaders() });
  }
}
