import { formatTemplateDate, shiftBusinessDate, weekdayIndex } from './businessDate.js';

const DATE_OFFSETS = {
  today: 0,
  date: 0,
  tomorrow: 1,
  nextday: 1,
  yesterday: -1,
  '今天': 0,
  '日期': 0,
  '明天': 1,
  '昨天': -1,
};

const PERIOD_WEEK_OFFSETS = {
  thisweek: 0,
  lastweek: -1,
  nextweek: 1,
  '本周': 0,
  '上周': -1,
  '上一周': -1,
  '下周': 1,
  '下一周': 1,
};

const PERIOD_ENDPOINTS = {
  start: 'start',
  begin: 'start',
  end: 'end',
  '开始': 'start',
  '起': 'start',
  '结束': 'end',
  '止': 'end',
};

function mondayOfWeek(value) {
  const weekday = weekdayIndex(value);
  if (weekday === null) return '';
  return shiftBusinessDate(value, -(weekday === 0 ? 6 : weekday - 1));
}

function resolveWeekPeriod(baseDate, weekOffset) {
  const monday = shiftBusinessDate(mondayOfWeek(baseDate), weekOffset * 7);
  return {
    start: monday,
    end: shiftBusinessDate(monday, 6),
  };
}

function renderWeekToken(token, formatText, baseDate) {
  const [periodName, endpointName] = token.split('.');
  const weekOffset = PERIOD_WEEK_OFFSETS[periodName.toLowerCase()] ?? PERIOD_WEEK_OFFSETS[periodName];
  if (weekOffset === undefined) return null;

  const period = resolveWeekPeriod(baseDate, weekOffset);
  const format = (formatText || 'YYYY-MM-DD').trim();
  if (!endpointName) {
    return `${formatTemplateDate(period.start, format)} - ${formatTemplateDate(period.end, format)}`;
  }

  const endpoint = PERIOD_ENDPOINTS[endpointName.toLowerCase()] ?? PERIOD_ENDPOINTS[endpointName];
  return endpoint ? formatTemplateDate(period[endpoint], format) : null;
}

export function renderTemplateVariables(content, baseDate) {
  return String(content || '').replace(
    /\{\{\s*([^:{}\s]+)(?::([+-]?\d+))?(?::([^}]+))?\s*\}\}/g,
    (match, token, offsetText, formatText) => {
      const weekValue = renderWeekToken(token, offsetText && !formatText ? offsetText : formatText, baseDate);
      if (weekValue !== null && offsetText === undefined) return weekValue;

      const normalizedToken = token.toLowerCase();
      const namedOffset = DATE_OFFSETS[normalizedToken] ?? DATE_OFFSETS[token];
      if (namedOffset === undefined) return match;

      const explicitOffset = offsetText === undefined ? null : Number(offsetText);
      const offset = Number.isFinite(explicitOffset) ? explicitOffset : namedOffset;
      return formatTemplateDate(shiftBusinessDate(baseDate, offset), (formatText || 'YYYY-MM-DD').trim());
    }
  );
}
