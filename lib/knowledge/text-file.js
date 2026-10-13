const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TEXT_TYPES } = require('./file-formats');

const MAX_CHARS = 500000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isTextFile = document => document?.sourceType === 'file' && Object.hasOwn(TEXT_TYPES, path.extname(document.fileMeta?.filename || '').toLowerCase());
const failure = (reason, status = 400) => ({ editable: false, supportsHistory: false, reason, error: reason, status });

function encodeText(content, bom = false) {
  if (typeof content !== 'string' || typeof bom !== 'boolean') return failure('原文或 BOM 格式无效');
  if (content.length > MAX_CHARS || Buffer.byteLength(JSON.stringify({ content, bom })) > MAX_BODY_BYTES - 16384) return failure('文本超过编辑大小限制', 413);
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content)) return failure('文件含二进制控制字符，仅支持只读预览');
  const body = Buffer.from(content, 'utf8');
  if (body.toString('utf8') !== content) return failure('文本包含无效 Unicode 字符');
  return { bytes: bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body };
}

function readText(document, filePath) {
  if (!isTextFile(document)) return failure('此格式不支持原文编辑与版本历史');
  if (!filePath) return failure('原始文件不存在或路径不安全', 404);
  let bytes;
  try {
    if (fs.statSync(filePath).size > MAX_BODY_BYTES) return failure('文本超过编辑大小限制', 413);
    bytes = fs.readFileSync(filePath);
  } catch { return failure('原始文件不存在或无法读取', 404); }
  const fingerprint = digest(bytes);
  if (fingerprint !== document.fileMeta?.sha256) return { ...failure('源文件已变化，请同步知识库后重新打开', 409), baseFingerprint: fingerprint };
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes); }
  catch { return failure('文件不是有效 UTF-8，仅支持只读预览'); }
  const validation = encodeText(content, bom);
  if (validation.error) return validation;
  return { content, bom, bytes: bytes.length, baseFingerprint: fingerprint, baseVersion: document.version,
    editable: document.status !== 'archived', supportsHistory: true,
    reason: document.status === 'archived' ? '文件已归档，仅支持只读' : '' };
}

module.exports = { isTextFile, readText, encodeText, digest, MAX_CHARS, MAX_BODY_BYTES };
