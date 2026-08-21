const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  stripAttachmentSuffix,
  buildAiProviderMessages,
} = require('../lib/agent/provider-messages');

function visionOptions(supportsMedia = true) {
  return {
    provider: 'moonshot',
    model: 'kimi-k3',
    thinkingMode: 'enabled',
    profile: { supportsMedia, preserveReasoning: true, thinking: 'k3' },
  };
}

function makeUploadFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-msg-'));
  const uploadsDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = '1735-test.png';
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return {
    dir,
    filename,
    mediaContext: {
      dataDir: dir,
      isSafeUploadFilename: name => name === filename,
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('stripAttachmentSuffix removes agent attachment suffix line', () => {
  assert.equal(
    stripAttachmentSuffix('识别图片内容\n（附件：/uploads/foo.jpg）'),
    '识别图片内容',
  );
  assert.equal(stripAttachmentSuffix('plain text'), 'plain text');
});

test('buildAiProviderMessages injects image_url parts for vision models', async () => {
  const fixture = makeUploadFixture();
  try {
    const messages = [{
      role: 'user',
      content: `这张图片是什么内容\n（附件：/uploads/${fixture.filename}）`,
      attachments: [{ url: `/uploads/${fixture.filename}`, filename: fixture.filename }],
    }];
    const output = await buildAiProviderMessages(messages, visionOptions(true), fixture.mediaContext);
    assert.equal(output.length, 1);
    assert.equal(output[0].role, 'user');
    assert.ok(Array.isArray(output[0].content));
    assert.equal(output[0].content[0].type, 'text');
    assert.equal(output[0].content[0].text, '这张图片是什么内容');
    assert.equal(output[0].content[1].type, 'image_url');
    assert.match(output[0].content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    fixture.cleanup();
  }
});

test('buildAiProviderMessages injects image_url parts for DeepSeek vision models', async () => {
  const fixture = makeUploadFixture();
  try {
    const messages = [{
      role: 'user',
      content: `这张图片是什么内容\n（附件：/uploads/${fixture.filename}）`,
      attachments: [{ url: `/uploads/${fixture.filename}`, filename: fixture.filename }],
    }];
    const output = await buildAiProviderMessages(messages, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash-vision-exp',
      thinkingMode: 'enabled',
      profile: { supportsMedia: true, preserveReasoning: false },
    }, fixture.mediaContext);
    assert.equal(output.length, 1);
    assert.equal(output[0].role, 'user');
    assert.ok(Array.isArray(output[0].content));
    assert.equal(output[0].content[0].type, 'text');
    assert.equal(output[0].content[0].text, '这张图片是什么内容');
    assert.equal(output[0].content[1].type, 'image_url');
    assert.match(output[0].content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    fixture.cleanup();
  }
});

test('buildAiProviderMessages keeps text-only content for non-vision models', async () => {
  const fixture = makeUploadFixture();
  try {
    const messages = [{
      role: 'user',
      content: `describe this\n（附件：/uploads/${fixture.filename}）`,
      attachments: [{ url: `/uploads/${fixture.filename}`, filename: fixture.filename }],
    }];
    const output = await buildAiProviderMessages(messages, visionOptions(false), fixture.mediaContext);
    assert.equal(output.length, 1);
    assert.equal(typeof output[0].content, 'string');
    assert.match(output[0].content, /（附件：/);
  } finally {
    fixture.cleanup();
  }
});

test('buildAiProviderMessages leaves assistant messages unchanged', async () => {
  const output = await buildAiProviderMessages([
    { role: 'assistant', content: 'hello' },
  ], visionOptions(true), null);
  assert.deepEqual(output, [{ role: 'assistant', content: 'hello' }]);
});
