import { buildSignedQuery, buildSignedForm } from './auth';
import { ApiCredentials } from '../types';
import { getRateLimitedAxios } from './requestInterceptor';
import { ASTER_REST_BASE_URL } from '../exchange/aster/constants';

const BASE_URL = ASTER_REST_BASE_URL;

export interface PositionModeResponse {
  dualSidePosition: boolean;
}

export async function getPositionMode(api: ApiCredentials): Promise<boolean> {
  const queryString = buildSignedQuery({}, api);

  try {
    const axios = getRateLimitedAxios();
    const response = await axios.get<PositionModeResponse>(
      `${BASE_URL}/fapi/v1/positionSide/dual?${queryString}`,
      {
        headers: {
          'X-MBX-APIKEY': api.apiKey,
        },
      }
    );

    return response.data.dualSidePosition;
  } catch (error) {
    console.error('Failed to get position mode:', error);
    throw error;
  }
}

export async function setPositionMode(dualSidePosition: boolean, api: ApiCredentials): Promise<void> {
  const params = buildSignedForm({
    dualSidePosition: dualSidePosition.toString(),
  }, api);

  try {
    const axios = getRateLimitedAxios();
    await axios.post(
      `${BASE_URL}/fapi/v1/positionSide/dual`,
      params.toString(),
      {
        headers: {
          'X-MBX-APIKEY': api.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log(`Position mode set to ${dualSidePosition ? 'Hedge Mode' : 'One-way Mode'}`);
  } catch (error) {
    console.error('Failed to set position mode:', error);
    throw error;
  }
}

export function getPositionSide(isHedgeMode: boolean, side: 'BUY' | 'SELL'): string {
  if (!isHedgeMode) {
    return 'BOTH';
  }

  return side === 'BUY' ? 'LONG' : 'SHORT';
}

export function getOppositePositionSide(positionSide: string): string {
  switch (positionSide) {
    case 'LONG':
      return 'SHORT';
    case 'SHORT':
      return 'LONG';
    case 'BOTH':
    default:
      return 'BOTH';
  }
}