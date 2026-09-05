const { readAttachmentForProvider, MAX_TOTAL_TEXT_CHARS, MAX_NATIVE_BYTES } = require('./attachments');

const ATTACHMENT_SUFFIX_PATTERN = /\n（附件：[^）]+）\s*$/;

function stripAttachmentSuffix(text) {
  return String(text || '').replace(ATTACHMENT_SUFFIX_PATTERN, '').trim();
}

function shouldPreserveMoonshotReasoning(options) {
  return options.profile?.preserveReasoning === true
    && (options.profile?.thinking !== 'optional' || options.thinkingMode !== 'disabled');
}

function asDataUri(item) {
  const mime = item.mimeType || 'application/octet-stream';
  return `data:${mime};base64,${item.buffer.toString('base64')}`;
}

function shouldUseNativeFile(options, item) {
  const transport = options?.profile?.fileTransport || 'local';
  if (transport === 'local' || item.kind === 'image' || item.buffer.length > MAX_NATIVE_BYTES) return false;
  const apiFormat = options?.profile?.apiFormat || options?.apiFormat || 'openai';
  if (apiFormat === 'responses') return true;
  return apiFormat === 'anthropic' && item.kind === 'pdf';
}

function nativeFilePart(options, item) {
  const data = item.buffer.toString('base64');
  const apiFormat = options?.profile?.apiFormat || options?.apiFormat || 'openai';
  if (apiFormat === 'responses') {
    return { type: 'input_file', filename: item.filename, file_data: `data:${item.mimeType};base64,${data}` };
  }
  if (apiFormat === 'anthropic' && item.kind === 'pdf') {
    return { type: 'document', source: { type: 'base64', media_type: item.mimeType, data } };
  }
  return null;
}

function attachmentTextPart(item, text) {
  const name = String(item.filename || 'attachment').replace(/[\r\n]/g, ' ').slice(0, 240);
  const status = item.status === 'needs_ocr'
    ? '\n[提示：该 PDF 可能是扫描件，当前未提取到完整文字，需要 OCR。]'
    : item.status === 'parse_error'
      ? '\n[提示：该附件解析失败，请转换为 TXT/Markdown/PDF 后重试。]'
      : item.status === 'truncated'
        ? '\n[提示：附件内容过长，已截断。建议导入知识库后按需检索。]'
        : '';
  return `\n\n<attachment filename="${name}" untrusted="true">\n${text || '[附件没有可提取的文字内容。]'}${status}\n</attachment>`;
}

async function buildUserContentWithAttachments(message, options, mediaContext) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (message.role !== 'user' || !attachments.length || !mediaContext?.dataDir) return message.content;

  const text = stripAttachmentSuffix(message.content);
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  let totalTextChars = 0;
  let found = 0;
  let unsupportedImages = 0;
  let foundNonImage = false;

  for (const attachment of attachments.slice(0, 14)) {
    const item = await readAttachmentForProvider(attachment, mediaContext, {
      maxChars: Math.min(200000, Math.max(1, MAX_TOTAL_TEXT_CHARS - totalTextChars)),
    });
    if (!item) {
      if (attachment?.kind === 'image' || /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i.test(String(attachment?.displayName || attachment?.filename || ''))) {
        unsupportedImages += 1;
      }
      continue;
    }
    found += 1;
    if (item.kind === 'image') {
      if (options?.profile?.supportsMedia === true) parts.push({ type: 'image_url', image_url: { url: asDataUri(item) } });
      else unsupportedImages += 1;
      continue;
    }
    foundNonImage = true;
    if (shouldUseNativeFile(options, item)) {
      const native = nativeFilePart(options, item);
      if (native) {
        parts.push(native);
        continue;
      }
    }
    const remaining = Math.max(0, MAX_TOTAL_TEXT_CHARS - totalTextChars);
    const extracted = String(item.text || '').slice(0, remaining);
    totalTextChars += extracted.length;
    parts.push({ type: 'text', text: attachmentTextPart(item, extracted) });
  }

  if (unsupportedImages) {
    parts.push({ type: 'text', text: `\n\n[${unsupportedImages} 个图片附件未发送：当前模型不支持视觉输入。]` });
  }
  if (!found) return message.content;
  if (!foundNonImage && unsupportedImages && options?.profile?.supportsMedia !== true) return message.content;
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

async function buildAiProviderMessages(messages, options, mediaContext = null) {
  const output = [];
  const preserveReasoning = shouldPreserveMoonshotReasoning(options);
  for (const message of messages) {
    if (message.role === 'assistant' && options.provider === 'moonshot' &&
        (!message.provider || (message.provider === 'moonshot' && (!message.modelId || message.modelId === options.model)))) {
      for (const traceEntry of message.providerTrace || []) output.push(traceEntry);
    }
    const providerMessage = {
      role: message.role,
      content: message.role === 'user'
        ? await buildUserContentWithAttachments(message, options, mediaContext)
        : message.content,
    };
    if (message.role === 'assistant' && options.provider === 'moonshot' && preserveReasoning && message.reasoningContent) {
      providerMessage.reasoning_content = message.reasoningContent;
    }
    if (message.role === 'assistant' && options.provider === 'openrouter' &&
        message.provider === 'openrouter' && message.modelId === options.model && message.openrouterReasoningDetails?.length) {
      providerMessage.reasoning_details = message.openrouterReasoningDetails;
    }
    output.push(providerMessage);
  }
  return output;
}

module.exports = {
  ATTACHMENT_SUFFIX_PATTERN,
  stripAttachmentSuffix,
  buildAiProviderMessages,
  buildUserContentWithAttachments,
};
