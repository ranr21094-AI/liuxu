const test = require('node:test');
const assert = require('node:assert/strict');
const { createSmtpSender, normalizeMailConfig } = require('../lib/mail/smtp');

test('SMTP sender maps SSL, STARTTLS, and plaintext modes and supports optional auth', async () => {
  const cases = [
    { secureMode: 'ssl', port: 465, secure: true, requireTLS: false, authUser: 'sender@example.com', password: 'secret' },
    { secureMode: 'starttls', port: 587, secure: false, requireTLS: true, authUser: 'sender@example.com', password: 'secret' },
    { secureMode: 'none', port: 25, secure: false, requireTLS: false, authUser: '', password: '' },
  ];
  for (const item of cases) {
    let transportOptions;
    let message;
    let closed = false;
    const send = createSmtpSender({
      transportFactory(options) {
        transportOptions = options;
        return {
          async sendMail(value) { message = value; },
          close() { closed = true; },
        };
      },
    });
    const config = normalizeMailConfig({
      host: 'smtp.example.com',
      port: item.port,
      secureMode: item.secureMode,
      authUser: item.authUser,
      password: item.password,
      fromAddress: 'from@example.com',
    });
    assert.equal(config.ready, true);
    await send(config, {
      from: 'agent-controlled@example.com',
      to: 'recipient@example.com',
      subject: 'A subject',
      text: 'Plain text only',
      html: '<b>ignored</b>',
      attachments: [{ path: '/etc/passwd' }],
    });
    assert.equal(transportOptions.secure, item.secure);
    assert.equal(transportOptions.requireTLS, item.requireTLS);
    assert.equal(transportOptions.disableFileAccess, true);
    assert.equal(transportOptions.disableUrlAccess, true);
    assert.equal(Boolean(transportOptions.auth), Boolean(item.authUser));
    assert.equal(message.from, 'from@example.com');
    assert.equal(message.to, 'recipient@example.com');
    assert.equal(message.text, 'Plain text only');
    assert.equal('html' in message, false);
    assert.equal('attachments' in message, false);
    assert.equal(closed, true);
  }
});

test('SMTP sender rejects incomplete credentials and closes transport after a send failure', async () => {
  assert.equal(normalizeMailConfig({
    host: 'smtp.example.com', port: 587, secureMode: 'starttls',
    authUser: 'sender@example.com', password: '', fromAddress: 'sender@example.com',
  }).ready, false);
  assert.equal(normalizeMailConfig({
    host: 'smtp.example.com', port: 70000, secureMode: 'starttls', fromAddress: 'sender@example.com',
  }).ready, false);
  let closed = false;
  const send = createSmtpSender({
    transportFactory() {
      return {
        async sendMail() { throw new Error('connection refused'); },
        close() { closed = true; },
      };
    },
  });
  await assert.rejects(send({
    host: 'smtp.example.com', port: 25, secureMode: 'none', fromAddress: 'sender@example.com',
  }, { to: 'recipient@example.com', subject: 'test', text: 'test' }), /connection refused/);
  assert.equal(closed, true);
});
