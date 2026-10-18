// Lighter timestamps in ms. The unit is unverified (spec §9 Q3) and differs per field (s, ms, µs
// transaction_time, ns), so it is normalized by magnitude. Anything that is not a positive number (or numeric
// string) is null.
export function lighterTimestampToMs(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'string' ? (value.trim() === '' ? NaN : Number(value)) : value;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return Math.round(n * 1000); // seconds
  if (n < 1e14) return Math.round(n);        // ms
  if (n < 1e17) return Math.floor(n / 1e3);  // µs (transaction_time)
  return Math.floor(n / 1e6);                // ns
}
