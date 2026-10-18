// Config without credentials, for anything broadcast to dashboard clients over the bot's WebSocket.
// `api` holds the Aster key and secret; `venues` holds every other venue's credentials (the Lighter API
// private key among them), so both are dropped whole rather than field by field.
export function withoutSecrets<T extends { api?: unknown; venues?: unknown }>(config: T): Omit<T, 'api' | 'venues'> {
  const { api: _api, venues: _venues, ...publicConfig } = config;
  return publicConfig;
}
