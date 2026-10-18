import { Config, lighterCredentialProblems, lighterHedgeState } from './types';

// What the bot needs before it may trade with real money (paper mode off), as the message of the first thing that
// is missing, or undefined when it has everything. configLoader refuses to load a config with such a problem and
// POST /api/config refuses to save one, both with this message, so a config the bot would not start with is never
// written. The messages name what is missing and never contain the credentials themselves.
export function liveModeProblem(config: Config): string | undefined {
  if (config.global.paperMode) return undefined;

  if (config.global.exchange === 'lighter') {
    const problems = lighterCredentialProblems(config.venues?.lighter);
    if (problems.length > 0) {
      return `Lighter credentials are required when not in paper mode: ${problems.join('; ')}`;
    }
    // Hedge mode switched on with half a short account would trade the shorts nowhere: refuse instead
    const hedge = lighterHedgeState(config);
    if (hedge.mode === 'incomplete') {
      return `Lighter hedge mode needs a complete short account when not in paper mode: ${hedge.problems.join('; ')}. Fill it in or turn hedge mode off.`;
    }
    return undefined;
  }

  if (!config.api.apiKey || !config.api.secretKey) {
    return 'API keys are required when not in paper mode';
  }
  if (config.api.apiKey.length !== 64 || config.api.secretKey.length !== 64) {
    return 'API keys must be 64 characters when not in paper mode';
  }
  return undefined;
}
