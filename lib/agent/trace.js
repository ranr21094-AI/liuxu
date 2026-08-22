function traceLabel(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  switch (event?.type) {
    case 'run.started':
      return '正在分析目标';
    case 'assistant.delta':
      return payload.text ? '正在组织回答' : '';
    case 'tool.proposed': {
      const names = Array.isArray(payload.calls)
        ? payload.calls.map(call => call?.name).filter(Boolean)
        : [];
      return `准备使用 ${names.join('、') || '工具'}`;
    }
    case 'tool.started':
      return `正在执行 ${payload.name || payload.call?.name || '工具'}`;
    case 'tool.completed':
      return payload.result?.summary || payload.call?.name || '工具执行完成';
    case 'checkpoint.updated':
      return '已更新工作进度';
    case 'delegate.started':
      return payload.delegateTitle ? `已委派子任务「${payload.delegateTitle}」` : '已委派子任务';
    case 'delegate.completed':
      return payload.delegateTitle ? `子任务「${payload.delegateTitle}」已完成` : '子任务已完成';
    case 'delegate.progress':
      return payload.delegateTitle ? `子任务「${payload.delegateTitle}」继续执行` : '子任务继续执行';
    case 'user_input.required':
      return payload.question ? `等待你的回答：${payload.question}` : '等待你的回答';
    case 'approval.required': {
      const total = Number(payload.queueTotal);
      const index = Number(payload.queueIndex);
      if (Number.isFinite(total) && total > 1 && Number.isFinite(index) && index > 0) {
        return `等待确认（${index}/${total}）`;
      }
      return '等待你的确认';
    }
    case 'client_tool.requested':
      return '等待浏览器返回结果';
    case 'run.completed':
      return '运行完成';
    case 'run.failed':
      return payload.error === 'cancelled' ? '运行已停止。' : `运行未完成：${payload.error || '未知错误'}`;
    default:
      return '';
  }
}

function traceLinesFromEvents(events) {
  const lines = [];
  for (const event of Array.isArray(events) ? events : []) {
    const label = String(traceLabel(event) || '').trim();
    if (!label || lines.at(-1) === label) continue;
    lines.push(label);
  }
  return lines;
}

function summarizeDelegateRun(run) {
  if (!run || typeof run !== 'object') return null;
  return {
    id: run.id,
    delegateTitle: run.delegateTitle || run.goal || '委派任务',
    status: run.status,
    trace: traceLinesFromEvents(run.events),
  };
}

function summarizeRun(run, { listChildRuns } = {}) {
  if (!run || typeof run !== 'object') return null;
  const completedAt = (Array.isArray(run.events) ? run.events : [])
    .find(item => item?.type === 'run.completed')?.at || null;
  const summary = {
    id: run.id,
    status: run.status,
    trace: traceLinesFromEvents(run.events),
    completedAt,
  };
  if (typeof listChildRuns === 'function') {
    const delegateRuns = listChildRuns(run.id).map(summarizeDelegateRun).filter(Boolean);
    if (delegateRuns.length) summary.delegateRuns = delegateRuns;
  }
  return summary;
}

module.exports = {
  traceLabel,
  traceLinesFromEvents,
  summarizeDelegateRun,
  summarizeRun,
};
