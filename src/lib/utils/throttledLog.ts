/**
 * Rate limiter for log lines that repeat while something stays broken (a database that can't be opened fails the
 * same way on every save).
 *
 * The returned function runs `emit` at most once per `intervalMs`. `emit` is told how many calls were skipped since
 * it last ran, so the line can say so.
 */
export function createLogThrottle(intervalMs: number, now: () => number = () => Date.now()) {
  let lastEmitAt = -Infinity;
  let skipped = 0;
  return (emit: (skipped: number) => void): void => {
    const time = now();
    if (time - lastEmitAt < intervalMs) {
      skipped++;
      return;
    }
    lastEmitAt = time;
    const count = skipped;
    skipped = 0;
    emit(count);
  };
}

// " (N similar errors since the last one)" for the line emitted after `skipped` suppressed calls
export function suppressedSuffix(skipped: number): string {
  return skipped > 0 ? ` (${skipped} similar error${skipped === 1 ? '' : 's'} since the last one)` : '';
}
