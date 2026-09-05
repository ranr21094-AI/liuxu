const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyAttachment,
  inspectUploadedAttachment,
  readAttachmentForProvider,
} = require('../lib/agent/attachments');
const { buildAiProviderMessages } = require('../lib/agent/provider-messages');
const { convertOpenAiMessagesToResponsesInput } = require('../lib/agent/custom-api');

function fixtureDirectory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-agent-attachments-'));
  const uploads = path.join(dir, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  return { dir, uploads, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('classifyAttachment accepts documents, code and common text formats', () => {
  assert.equal(classifyAttachment('notes.md').kind, 'text');
  assert.equal(classifyAttachment('payload.json').kind, 'text');
  assert.equal(classifyAttachment('server.ts').kind, 'code');
  assert.equal(classifyAttachment('report.pdf').kind, 'pdf');
  assert.equal(classifyAttachment('report.docx').kind, 'docx');
  assert.match(classifyAttachment('legacy.doc').error, /docx|PDF/);
  assert.match(classifyAttachment('archive.exe').error, /不支持/);
});

test('inspectUploadedAttachment returns safe metadata and rejects binary text', async () => {
  const fixture = fixtureDirectory();
  try {
    const filename = '123-text.json';
    const filePath = path.join(fixture.uploads, filename);
    fs.writeFileSync(filePath, '{"ok":true}\n');
    const item = await inspectUploadedAttachment({
      path: filePath,
      filename,
      originalname: 'payload.json',
      mimetype: 'application/json',
      size: fs.statSync(filePath).size,
    });
    assert.equal(item.kind, 'text');
    assert.equal(item.displayName, 'payload.json');
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.equal(item.extractionStatus, 'active');

    const binaryPath = path.join(fixture.uploads, '123-code.js');
    fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02]));
    await assert.rejects(
      inspectUploadedAttachment({ path: binaryPath, filename: '123-code.js', originalname: 'code.js', mimetype: 'text/javascript', size: 3 }),
      /二进制/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('provider messages include local text attachments for any chat protocol', async () => {
  const fixture = fixtureDirectory();
  try {
    const filename = '123-note.md';
    fs.writeFileSync(path.join(fixture.uploads, filename), '# Local note\nhello');
    const output = await buildAiProviderMessages([{
      role: 'user',
      content: '请总结附件\n（附件：/uploads/123-note.md）',
      attachments: [{ url: '/uploads/123-note.md', filename, displayName: 'note.md', kind: 'text' }],
    }], {
      provider: 'custom',
      model: 'demo',
      profile: { apiFormat: 'openai', fileTransport: 'local' },
    }, {
      dataDir: fixture.dir,
      isSafeUploadFilename: name => name === filename,
      allowPrivate: true,
    });
    assert.ok(Array.isArray(output[0].content));
    assert.match(output[0].content.map(item => item.text || '').join('\n'), /Local note/);
    assert.match(output[0].content.map(item => item.text || '').join('\n'), /untrusted/);
  } finally {
    fixture.cleanup();
  }
});

test('Responses native file mode emits input_file without exposing a local path', async () => {
  const fixture = fixtureDirectory();
  try {
    const filename = '123-report.pdf';
    fs.writeFileSync(path.join(fixture.uploads, filename), Buffer.from('%PDF-1.4\n')); // parsing may report parse_error; bytes remain safe for native transport
    const output = await buildAiProviderMessages([{
      role: 'user',
      content: '分析 PDF\n（附件：/uploads/123-report.pdf）',
      attachments: [{ url: '/uploads/123-report.pdf', filename, displayName: 'report.pdf', kind: 'pdf', mimeType: 'application/pdf' }],
    }], {
      provider: 'custom',
      model: 'demo',
      profile: { apiFormat: 'responses', fileTransport: 'native' },
    }, {
      dataDir: fixture.dir,
      isSafeUploadFilename: name => name === filename,
      allowPrivate: true,
    });
    const converted = convertOpenAiMessagesToResponsesInput(output);
    const parts = converted.input[0].content;
    assert.equal(parts[0].type, 'input_text');
    assert.equal(parts[1].type, 'input_file');
    assert.match(parts[1].file_data, /^data:application\/pdf;base64,/);
    assert.doesNotMatch(JSON.stringify(parts), /123-report\.pdf.*uploads/);
  } finally {
    fixture.cleanup();
  }
});

test('readAttachmentForProvider blocks private files when diary access is absent', async () => {
  const fixture = fixtureDirectory();
  try {
    const filename = '123-secret.md';
    fs.writeFileSync(path.join(fixture.uploads, filename), 'private');
    const item = await readAttachmentForProvider({ url: `/uploads/${filename}`, filename, kind: 'text' }, {
      dataDir: fixture.dir,
      isSafeUploadFilename: name => name === filename,
      isPrivateUpload: name => name === filename,
      allowPrivate: false,
    });
    assert.equal(item, null);
  } finally {
    fixture.cleanup();
  }
});
