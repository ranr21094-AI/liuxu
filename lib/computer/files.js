const fs = require('fs');
const path = require('path');
const { toolResult } = require('../agent/tools');
const { resolveAllowed } = require('./policy');

function createFileTools(policy) {
  const allowed = policy.allowedDirectories || [];
  return {
    async execute(name, args = {}) {
      try {
        if (name === 'file.list') {
          const dir = resolveAllowed(args.path || allowed[0], allowed);
          const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200).map(entry => ({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
          }));
          return toolResult({ ok: true, summary: `Listed ${entries.length} entries`, data: entries, evidence: [{ type: 'path', path: dir }] });
        }
        if (name === 'file.read') {
          const file = resolveAllowed(args.path, allowed);
          const stat = fs.statSync(file);
          if (stat.size > 1024 * 1024) return toolResult({ ok: false, summary: 'File exceeds 1MB read limit', errorCode: 'too_large' });
          const content = fs.readFileSync(file, 'utf8');
          return toolResult({ ok: true, summary: `Read ${path.basename(file)}`, data: { path: file, content }, evidence: [{ type: 'path', path: file }] });
        }
        if (name === 'file.search') {
          const dir = resolveAllowed(args.path || allowed[0], allowed);
          const needle = String(args.query || '').toLowerCase();
          const hits = [];
          const walk = (current) => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true }).slice(0, 100)) {
              const full = path.join(current, entry.name);
              if (entry.isDirectory()) walk(full);
              else if (entry.name.toLowerCase().includes(needle)) hits.push(full);
              if (hits.length >= 50) return;
            }
          };
          walk(dir);
          return toolResult({ ok: true, summary: `Found ${hits.length} files`, data: hits, evidence: hits.slice(0, 8).map(item => ({ type: 'path', path: item })) });
        }
        if (name === 'file.write') {
          const file = resolveAllowed(args.path, allowed);
          fs.writeFileSync(file, String(args.content || ''), 'utf8');
          return toolResult({ ok: true, summary: `Wrote ${path.basename(file)}`, evidence: [{ type: 'path', path: file }] });
        }
        if (name === 'file.patch') {
          const file = resolveAllowed(args.path, allowed);
          const current = fs.readFileSync(file, 'utf8');
          const find = String(args.find || '');
          if (!find || !current.includes(find)) return toolResult({ ok: false, summary: 'Patch target was not found', errorCode: 'not_found' });
          const replacement = String(args.replace ?? '');
          fs.writeFileSync(file, current.replace(find, replacement), 'utf8');
          return toolResult({ ok: true, summary: `Patched ${path.basename(file)}`, evidence: [{ type: 'path', path: file }] });
        }
        if (name === 'file.move') {
          const source = resolveAllowed(args.source || args.path, allowed);
          const target = resolveAllowed(args.destination, allowed);
          fs.renameSync(source, target);
          return toolResult({ ok: true, summary: `Moved ${path.basename(source)}`, evidence: [{ type: 'path', path: target }] });
        }
        if (name === 'file.delete') {
          const file = resolveAllowed(args.path, allowed);
          fs.unlinkSync(file);
          return toolResult({ ok: true, summary: `Deleted ${path.basename(file)}`, evidence: [{ type: 'path', path: file }] });
        }
        return toolResult({ ok: false, summary: `Unsupported file tool ${name}`, errorCode: 'unknown_tool' });
      } catch (err) {
        return toolResult({ ok: false, summary: err.message, errorCode: 'file_error', retryable: false });
      }
    },
  };
}

module.exports = { createFileTools };
