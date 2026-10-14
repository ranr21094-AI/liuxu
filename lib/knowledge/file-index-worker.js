const { parentPort } = require('node:worker_threads');
const { extractText } = require('./import');
parentPort.on('message', async ({ id, payload }) => {
  try {
    const result = await extractText(Buffer.from(payload.bytes), payload.filename, payload.mimeType);
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.message, code: error.code }); }
});
