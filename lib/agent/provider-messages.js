const { resolveReferenceImages } = require('./seedream');

const ATTACHMENT_SUFFIX_PATTERN = /\n（附件：[^）]+）\s*$/;

function stripAttachmentSuffix(text) {
  return String(text || '').replace(ATTACHMENT_SUFFIX_PATTERN, '').trim();
}

function shouldPreserveMoonshotReasoning(options) {
  return options.provider === 'moonshot' && options.profile?.preserveReasoning &&
    (options.profile.thinking !== 'optional' || options.thinkingMode !== 'disabled');
}

async function buildUserContentWithAttachments(message, options, mediaContext) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const supportsMedia = options?.profile?.supportsMedia === true;
  if (message.role !== 'user' || !attachments.length || !supportsMedia || !mediaContext?.dataDir) {
    return message.content;
  }

  const urls = attachments.map(item => item?.url).filter(Boolean);
  if (!urls.length) return message.content;

  let dataUris;
  try {
    dataUris = await resolveReferenceImages(urls, {
      dataDir: mediaContext.dataDir,
      isSafeUploadFilename: mediaContext.isSafeUploadFilename,
    });
  } catch {
    return message.content;
  }
  if (!dataUris.length) return message.content;

  const text = stripAttachmentSuffix(message.content);
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of dataUris) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts.length ? parts : message.content;
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
