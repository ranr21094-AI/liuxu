async function defaultModelClient(settings = {}) {
  return {
    async complete({ goal, messages }) {
      const lastTool = [...(messages || [])].reverse().find(item => item.role === 'tool');
      if (lastTool) {
        try {
          const result = JSON.parse(lastTool.content || '{}');
          const evidence = Array.isArray(result.evidence) ? result.evidence : [];
          if (result.ok && lastTool.name === 'knowledge.search') {
            const items = Array.isArray(result.data) ? result.data.slice(0, 8) : [];
            const text = items.length
              ? `检索到 ${items.length} 个本地依据：\n${items.map(item => `- ${item.title || item.documentId}：${item.snippet || ''}`).join('\n')}`
              : '未检索到与目标直接相关的本地依据。';
            return { text, citations: items, toolCalls: [] };
          }
          if (result.ok) return { text: result.summary || '工具已完成。', citations: evidence, toolCalls: [] };
        } catch { /* continue with the deterministic fallback */ }
      }
      const last = [...(messages || [])].reverse().find(item => item.role === 'user');
      const text = last?.content || goal || '';
      const taskMatch = String(text).match(/(?:创建|新建|添加|安排)(?:一个)?(?:待办|任务)[：: ]*(.+)/i);
      if (taskMatch?.[1]) {
        return {
          text: '',
          toolCalls: [{ name: 'task.create', arguments: { title: taskMatch[1].trim().slice(0, 200) } }],
        };
      }
      if (/search|检索|查找|搜索|查询/i.test(text)) {
        return {
          text: '',
          toolCalls: [{ name: 'knowledge.search', arguments: { query: text } }],
        };
      }
      return { text: `未配置可用模型，已记录目标：${String(text).slice(0, 200)}`, toolCalls: [] };
    },
    settings,
  };
}

function wrapChatClient(sendChat) {
  return {
    async complete({ goal, messages, tools, memories }) {
      if (!sendChat) return (await defaultModelClient()).complete({ goal, messages });
      return sendChat({ goal, messages, tools, memories });
    },
  };
}

module.exports = { defaultModelClient, wrapChatClient };
