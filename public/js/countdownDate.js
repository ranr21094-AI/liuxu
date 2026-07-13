import { businessDateString, parseBusinessDate } from './businessDate.js';

function formatDateParts({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInCalendarMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function calendarDayNumber(value) {
  const parts = parseBusinessDate(value);
  return parts ? Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000) : null;
}

function annualOccurrence(targetParts, year) {
  return formatDateParts({
    year,
    month: targetParts.month,
    day: Math.min(targetParts.day, daysInCalendarMonth(year, targetParts.month)),
  });
}

export function countdownTiming(countdown, today = businessDateString()) {
  const targetParts = parseBusinessDate(countdown?.target_date);
  const todayParts = parseBusinessDate(today);
  if (!targetParts || !todayParts) return { effectiveDate: '', days: 0, state: 'invalid' };

  let effectiveDate = countdown.repeat_yearly
    ? annualOccurrence(targetParts, todayParts.year)
    : countdown.target_date;
  if (countdown.repeat_yearly && effectiveDate < today) {
    effectiveDate = annualOccurrence(targetParts, todayParts.year + 1);
  }
  const days = calendarDayNumber(effectiveDate) - calendarDayNumber(today);
  return {
    effectiveDate,
    days,
    state: days === 0 ? 'today' : (days > 0 ? 'future' : 'elapsed'),
  };
}
