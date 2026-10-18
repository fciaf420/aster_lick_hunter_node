const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Tooltip label for a "YYYY-MM-DD" chart date, for example "Sep 1, 2025". It is read from the
 * string instead of a Date, so there is no timezone shift, and the month is spelled out, so it
 * means the same in every locale (9/1/2025 and 1/9/2025 are different days). Anything that is
 * not a plain date is returned unchanged.
 */
export function formatChartDate(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return dateStr;

  const [, year, month, day] = match;
  const monthName = MONTH_NAMES[Number(month) - 1];
  const dayOfMonth = Number(day);
  if (!monthName || dayOfMonth < 1 || dayOfMonth > 31) return dateStr;

  return `${monthName} ${dayOfMonth}, ${year}`;
}
