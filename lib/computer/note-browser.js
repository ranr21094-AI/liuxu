const { toolResult } = require('../agent/tools');
const fs = require('node:fs');
const path = require('node:path');

function clearNoteBrowserState(dataDir) {
  const filePath = path.join(dataDir, '.note-browser-state.json');
  try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function createNoteBrowserBridge(enabled = process.env.LIUXU_DESKTOP === '1') {
  return {
    available() { return Boolean(enabled); },
    request(name, args, documentId) {
      if (!enabled) return toolResult({ ok: false, summary: '内置浏览器仅在桌面版可用', errorCode: 'unavailable' });
      return {
        clientTool: true,
        request: { name, args: args || {}, documentId: String(documentId || '') },
        result: toolResult({ ok: true, summary: `Requested ${name}`, data: null }),
      };
    },
  };
}

module.exports = { createNoteBrowserBridge, clearNoteBrowserState };
