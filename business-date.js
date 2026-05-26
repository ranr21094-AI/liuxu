const BUSINESS_TIME_ZONE = 'Asia/Hong_Kong';

const businessFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatParts({ year, month, day }) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function getBusinessDateParts(date = new Date()) {
  const parts = {};
  for (const part of businessFormatter.formatToParts(date)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      parts[part.type] = Number(part.value);
    }
  }
  return parts;
}

function businessDateString(date = new Date()) {
  return formatParts(getBusinessDateParts(date));
}

function parseDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    check.getUTCFullYear() !== parts.year ||
    check.getUTCMonth() !== parts.month - 1 ||
    check.getUTCDate() !== parts.day
  ) {
    return null;
  }
  return parts;
}

function shiftDateString(value, days) {
  const parts = parseDateParts(value);
  if (!parts) return '';
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return formatParts({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

function weekdayIndex(value) {
  const parts = parseDateParts(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function daysInMonth(value) {
  const parts = parseDateParts(value);
  if (!parts) return 0;
  return new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
}

function startOfWeekMonday(value) {
  const weekday = weekdayIndex(value);
  if (weekday === null) return '';
  return shiftDateString(value, -(weekday === 0 ? 6 : weekday - 1));
}

module.exports = {
  BUSINESS_TIME_ZONE,
  businessDateString,
  daysInMonth,
  getBusinessDateParts,
  parseDateParts,
  shiftDateString,
  startOfWeekMonday,
  weekdayIndex,
};
