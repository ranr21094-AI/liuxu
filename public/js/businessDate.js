export const BUSINESS_TIME_ZONE = 'Asia/Hong_Kong';

const businessFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function fromParts({ year, month, day }) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function getBusinessDateParts(date = new Date()) {
  const result = {};
  for (const part of businessFormatter.formatToParts(date)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      result[part.type] = Number(part.value);
    }
  }
  return result;
}

export function businessDateString(date = new Date()) {
  return fromParts(getBusinessDateParts(date));
}

export function parseBusinessDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const result = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(result.year, result.month - 1, result.day));
  return (
    check.getUTCFullYear() === result.year &&
    check.getUTCMonth() === result.month - 1 &&
    check.getUTCDate() === result.day
  ) ? result : null;
}

export function shiftBusinessDate(value, days) {
  const parts = parseBusinessDate(value);
  if (!parts) return '';
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return fromParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

export function weekdayIndex(value) {
  const parts = parseBusinessDate(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function formatDateLabel(value) {
  const parts = parseBusinessDate(value);
  const weekday = weekdayIndex(value);
  if (!parts || weekday === null) return value || '';
  return `${parts.year}年${parts.month}月${parts.day}日 ${weekdays[weekday]}`;
}

export function formatShortDateLabel(value) {
  const parts = parseBusinessDate(value);
  const weekday = weekdayIndex(value);
  if (!parts || weekday === null) return '无日期';
  return `${parts.month}月${parts.day}日 ${weekdays[weekday]}`;
}

export function formatTemplateDate(value, format = 'YYYY-MM-DD') {
  const parts = parseBusinessDate(value);
  const weekday = weekdayIndex(value);
  if (!parts || weekday === null) return '';
  const values = {
    YYYY: String(parts.year),
    YY: String(parts.year).slice(-2),
    MM: pad2(parts.month),
    M: String(parts.month),
    DD: pad2(parts.day),
    D: String(parts.day),
    dddd: weekdays[weekday],
    ddd: weekdays[weekday],
  };
  return format.replace(/YYYY|dddd|ddd|YY|MM|DD|M|D/g, token => values[token]);
}
