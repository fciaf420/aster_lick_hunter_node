import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { FieldValues, Resolver } from 'react-hook-form';
import {
  LIGHTER_HEX_KEY_MESSAGE,
  LIGHTER_MAX_ACCOUNT_INDEX,
  LIGHTER_MAX_API_KEY_INDEX,
  LIGHTER_MAX_SEND_TX_PER_MIN,
  LIGHTER_MIN_ACCOUNT_INDEX,
  LIGHTER_MIN_API_KEY_INDEX,
  LIGHTER_MIN_SEND_TX_PER_MIN,
  configSchema,
  globalConfigSchema,
  hasVolumeThresholds,
  serverConfigSchema,
  symbolConfigObjectSchema,
} from './types';

// Validation of the config form. The rules are the ones /api/config applies (configSchema); this module only
// derives the form's view of them: a dashboard password rule the server does not have, per-field placement of the
// volume threshold rule, the wording of the inline errors, and how typed values become the saved payload.

export const DASHBOARD_PASSWORD_MIN_LENGTH = 4;
export const DASHBOARD_PASSWORD_MESSAGE = `Password must be at least ${DASHBOARD_PASSWORD_MIN_LENGTH} characters`;

// The server demands either the legacy threshold or both new ones; the form says which field is missing
const symbolFormSchema = symbolConfigObjectSchema.superRefine((symbol, ctx) => {
  if (hasVolumeThresholds(symbol)) return;
  for (const key of ['longVolumeThresholdUSDT', 'shortVolumeThresholdUSDT'] as const) {
    if (symbol[key] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Required' });
  }
});

// An empty dashboard password means "no password"; the old form refused anything from 1 to 3 characters
const serverFormSchema = serverConfigSchema.unwrap().extend({
  dashboardPassword: z.string()
    .refine((password) => password.length === 0 || password.length >= DASHBOARD_PASSWORD_MIN_LENGTH, DASHBOARD_PASSWORD_MESSAGE)
    .optional(),
}).optional();

export const configFormSchema = configSchema.extend({
  symbols: z.record(symbolFormSchema),
  global: globalConfigSchema.extend({ server: serverFormSchema }),
});

// The Lighter settings on their own (onboarding, tests): the same venues.lighter rules
export const lighterSettingsFormSchema = configFormSchema.pick({ venues: true });

// ===== Wording of the inline errors =====

// Fields whose range reads best as "Must be 1-254" (the schema only reports the bound that was crossed)
const LIGHTER_RANGES: Record<string, readonly [number, number]> = {
  accountIndex: [LIGHTER_MIN_ACCOUNT_INDEX, LIGHTER_MAX_ACCOUNT_INDEX],
  apiKeyIndex: [LIGHTER_MIN_API_KEY_INDEX, LIGHTER_MAX_API_KEY_INDEX],
  sendTxPerMin: [LIGHTER_MIN_SEND_TX_PER_MIN, LIGHTER_MAX_SEND_TX_PER_MIN],
};

// Never echoes the received value: the Lighter fields hold API keys
export const formErrorMap: z.ZodErrorMap = (issue, ctx) => {
  const range = LIGHTER_RANGES[String(issue.path[issue.path.length - 1])];
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: 'Required' };
      if (range) return { message: `Must be ${range[0]}-${range[1]}` };
      if (issue.expected === 'integer') return { message: 'Enter a whole number' };
      if (issue.expected === 'number') return { message: 'Enter a number' };
      break;
    case z.ZodIssueCode.too_small:
      if (issue.type === 'number') {
        if (range) return { message: `Must be ${range[0]}-${range[1]}` };
        return { message: issue.inclusive ? `Must be at least ${issue.minimum}` : `Must be greater than ${issue.minimum}` };
      }
      break;
    case z.ZodIssueCode.too_big:
      if (issue.type === 'number') {
        if (range) return { message: `Must be ${range[0]}-${range[1]}` };
        return { message: issue.inclusive ? `Must be at most ${issue.maximum}` : `Must be less than ${issue.maximum}` };
      }
      break;
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Choose one of: ${issue.options.join(', ')}` };
  }
  return { message: ctx.defaultError };
};

// The schema's own messages read as a fragment after "path: " in API errors ("must differ from ..."): shown
// inline they start with a capital, and the hex key message keeps the wording the Lighter card always had
const INLINE_MESSAGES: Record<string, string> = {
  [LIGHTER_HEX_KEY_MESSAGE]: 'Expected 40 bytes of hex (80 characters)',
};

export function inlineMessage(message: string): string {
  return INLINE_MESSAGES[message] ?? message.charAt(0).toUpperCase() + message.slice(1);
}

// ===== Form values and the saved payload =====

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);

// null is a real value in the config here (an emptied host means "detect it"); anywhere else it marks a cleared field
const NULLABLE_PATHS = new Set(['global.server.websocketHost']);

// react-hook-form hands a field its default value again when the field holds undefined, so a cleared field holds
// null in the form. The payload leaves cleared fields out, as the form always has, and also the empty objects that
// registering a field creates (venues.lighter.hedge.shortAccount for a Lighter config without a short account):
// only an object that was in the loaded config stays, even when it ends up empty.
export function withoutClearedFields<T>(values: T, loaded?: unknown): T {
  const prune = (value: Plain, loadedValue: unknown, path: string): Plain => {
    const kept: Plain = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (child === undefined) continue;
      if (child === null) {
        if (NULLABLE_PATHS.has(childPath)) kept[key] = null;
        continue;
      }
      if (isPlain(child)) {
        const loadedChild = isPlain(loadedValue) ? loadedValue[key] : undefined;
        const pruned = prune(child, loadedChild, childPath);
        if (Object.keys(pruned).length > 0 || isPlain(loadedChild)) kept[key] = pruned;
      } else {
        kept[key] = child;
      }
    }
    return kept;
  };
  return (isPlain(values) ? prune(values, loaded, '') : values) as T;
}

// Resolver for react-hook-form: validates the values as they will be saved. It hands them back as typed ("raw"),
// not as parsed: the server parses and strips them itself, and what the form posts must stay what it always was.
export function createConfigResolver<T extends FieldValues>(schema: z.ZodTypeAny, loaded?: unknown): Resolver<T> {
  // The resolver types ParseParams as complete; zod only needs the error map
  const validate = zodResolver(schema, { errorMap: formErrorMap } as z.ParseParams, { raw: true }) as unknown as Resolver<T>;
  return async (values, context, options) => {
    const result = await validate(withoutClearedFields(values, loaded), context, options);
    rewordErrors(result.errors);
    return result;
  };
}

function rewordErrors(node: unknown): void {
  if (!isPlain(node)) return;
  if (typeof node.message === 'string' && typeof node.type === 'string') {
    node.message = inlineMessage(node.message);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'ref') rewordErrors(child);
  }
}
