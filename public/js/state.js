// Shared application state
import { businessDateString, parseBusinessDate } from './businessDate.js';

const today = businessDateString();
const now = parseBusinessDate(today);
const currentMonthValue = today.substring(0, 7);

// Magic phrase that unlocks the hidden diary when typed in the search box.
// Keep in sync with DIARY_MAGIC_PHRASE in server.js.
export const DIARY_MAGIC_PHRASE = '如意如意';

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
