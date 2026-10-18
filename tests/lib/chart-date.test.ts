import { formatChartDate } from '../../src/lib/utils/chart-date';

describe('formatChartDate', () => {
  it('spells out the month so the date reads the same in every locale', () => {
    expect(formatChartDate('2025-09-01')).toBe('Sep 1, 2025');
    expect(formatChartDate('2025-01-31')).toBe('Jan 31, 2025');
    expect(formatChartDate('2024-12-09')).toBe('Dec 9, 2024');
  });

  it('does not shift the day with the time zone (it reads the string, not a Date)', () => {
    const original = process.env.TZ;
    try {
      ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'].forEach((zone) => {
        process.env.TZ = zone;
        expect(formatChartDate('2025-09-26')).toBe('Sep 26, 2025');
      });
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('returns anything that is not a plain date unchanged', () => {
    expect(formatChartDate('')).toBe('');
    expect(formatChartDate('Sep 1')).toBe('Sep 1');
    expect(formatChartDate('2025-13-01')).toBe('2025-13-01');
    expect(formatChartDate('2025-00-10')).toBe('2025-00-10');
    expect(formatChartDate('2025-09-00')).toBe('2025-09-00');
    expect(formatChartDate('2025-09-32')).toBe('2025-09-32');
    expect(formatChartDate('2025-09-01T10:00:00Z')).toBe('2025-09-01T10:00:00Z');
  });
});
