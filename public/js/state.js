// Shared application state
import { businessDateString, parseBusinessDate } from './businessDate.js';

const today = businessDateString();
const now = parseBusinessDate(today);
const currentMonthValue = today.substring(0, 7);

export const state = {
  selectedDate: null,
  currentMonth: now.month - 1,
  currentYear: now.year,
  currentPage: 1,
  editingId: null,
  search: '',
  category: '',
  month: currentMonthValue,
  datesWithLogs: [],
  datesWithTodos: [],
  categories: [],
  listScrollY: null,
  diaryLockEnabled: false,
  diaryUnlocked: true,
};
