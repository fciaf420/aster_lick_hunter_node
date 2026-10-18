/**
 * Timestamp utility for consistent logging across the bot
 * Provides formatted timestamps for terminal output
 */

/**
 * Get current timestamp in ISO 8601 format with milliseconds
 * Example: 2025-10-11 09:05:29.736
 * @returns Formatted timestamp string
 */
export function getTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/**
 * Get current timestamp in a more compact format (without date)
 * Example: 09:05:29.736
 * @returns Formatted time string
 */
export function getTimeOnly(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');

  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/**
 * Log with timestamp prefix
 * @param args Arguments to log (same as console.log)
 */
export function logWithTimestamp(...args: any[]): void {
  const timestamp = getTimeOnly();
  console.log(`[${timestamp}]`, ...args);
}

/**
 * Log error with timestamp prefix
 * @param args Arguments to log (same as console.error)
 */
export function logErrorWithTimestamp(...args: any[]): void {
  const timestamp = getTimeOnly();
  console.error(`[${timestamp}]`, ...args);
}

/**
 * Log warning with timestamp prefix
 * @param args Arguments to log (same as console.warn)
 */
export function logWarnWithTimestamp(...args: any[]): void {
  const timestamp = getTimeOnly();
  console.warn(`[${timestamp}]`, ...args);
}
