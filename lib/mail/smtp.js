const nodemailer = require('nodemailer');

const SECURE_MODES = new Set(['none', 'starttls', 'ssl']);

function isValidMailbox(value) {
  return typeof value === 'string'
    && value.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizeMailConfig(config = {}) {
  const host = String(config.host || '').trim();
  const port = Number(config.port);
  const secureMode = String(config.secureMode || '');
  const authUser = String(config.authUser || '').trim();
  const password = String(config.password || '');
  const fromAddress = String(config.fromAddress || authUser).trim();
  const hasAuth = Boolean(authUser || password);
  let error = '';

  if (!host || host.length > 255 || /[\s/@\\]/.test(host)) error = 'SMTP 主机地址无效';
  else if (!Number.isInteger(port) || port < 1 || port > 65535) error = 'SMTP 端口无效';
  else if (!SECURE_MODES.has(secureMode)) error = 'SMTP 加密方式无效';
  else if (!isValidMailbox(fromAddress)) error = '发件邮箱地址无效';
  else if (Boolean(authUser) !== Boolean(password) && hasAuth) error = 'SMTP 账号和密码必须同时填写';

  const transportOptions = {
    host,
    port,
    secure: secureMode === 'ssl',
    requireTLS: secureMode === 'starttls',
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  if (authUser && password) transportOptions.auth = { user: authUser, pass: password };
  return {
    ready: !error,
    error,
    host,
    port,
    secureMode,
    authUser,
    password,
    fromAddress,
    source: config.source || 'custom',
    transportOptions,
  };
}

function createSmtpSender({ transportFactory = nodemailer.createTransport } = {}) {
  return async function send(config, message) {
    const normalized = normalizeMailConfig(config);
    if (!normalized.ready) throw new Error(normalized.error || 'SMTP 发件服务未配置完整');
    const transporter = transportFactory(normalized.transportOptions);
    try {
      await transporter.sendMail({
        from: normalized.fromAddress,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.textEncoding ? { textEncoding: message.textEncoding } : {}),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } finally {
      transporter.close?.();
    }
    return { from: normalized.fromAddress, to: message.to, subject: message.subject };
  };
}

module.exports = { SECURE_MODES, createSmtpSender, isValidMailbox, normalizeMailConfig };
