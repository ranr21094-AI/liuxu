import { state } from './state.js';
import { apiFetch } from './auth.js';
import { showToast, escHtml, $ } from './helpers.js';
import { renderCalendar } from './calendar.js';

export async function loadStats() {
  try {
    const res = await apiFetch('/api/stats');
    const stats = await res.json();
    const weekHours = $('#statWeekHours');
    const monthHours = $('#statMonthHours');
    const dailyAvg = $('#statDailyAvg');
    const totalLogs = $('#statTotalLogs');
    if (weekHours) weekHours.textContent = `${stats.weekHours}h`;
    if (monthHours) monthHours.textContent = `${stats.monthHours}h`;
    if (dailyAvg) dailyAvg.textContent = `${stats.dailyAvg}h`;
    if (totalLogs) totalLogs.textContent = stats.totalLogs;
    state.datesWithLogs = stats.datesWithLogs;
    renderCalendar();

    const chart = $('#categoryChart');
    if (!chart) return;
    if (stats.categoryBreakdown.length === 0) {
      chart.innerHTML = '<span style="font-size:0.75rem;opacity:0.6;">暂无数据</span>';
    } else {
      const maxHours = stats.categoryBreakdown[0].hours || 1;
      chart.innerHTML = stats.categoryBreakdown.map((c, i) => {
        const pct = Math.round((c.hours / maxHours) * 100);
        return `
          <div class="chart-bar-row">
            <span class="chart-bar-label">${escHtml(c.name)}</span>
            <span class="chart-bar-track">
              <span class="chart-bar-fill" style="width:${pct}%;background:var(--chart-${i % 8 + 1})"></span>
            </span>
            <span class="chart-bar-value">${c.hours}h</span>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Stats load failed:', err);
    showToast('加载统计失败', 'error');
  }
}
