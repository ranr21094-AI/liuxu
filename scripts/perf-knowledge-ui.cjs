// Isolated Electron benchmark. Never opens the user's data directory.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow } = require('electron');
const repo = path.resolve(process.env.PERF_REPO || path.join(__dirname, '..'));
const count = Math.max(1, Number(process.env.PERF_DOCS) || 1000);
const samples = Math.max(1, Number(process.env.PERF_SAMPLES) || 100);
const folders = Math.min(200, count);
const output = path.resolve(process.env.PERF_OUTPUT || path.join(repo, 'output', 'knowledge-performance', `${count}.json`));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-interaction-'));
const data = path.join(temporary, 'data'), root = path.join(temporary, 'files');
fs.mkdirSync(data); fs.mkdirSync(root);
app.setPath('userData', path.join(temporary, 'profile'));
process.env.DATA_DIR = data;
process.env.AI_SECRETS_KEY_FILE = path.join(data, 'key');
process.env.LIUXU_DESKTOP = '0';
fs.writeFileSync(path.join(data, '.knowledge-file-workspace.json'), JSON.stringify({ format: 'liuxu-file-workspace', version: 1, rootPath: root }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};
async function main() {
  const body = 'Knowledge benchmark paragraph.\n\n'.repeat(1100).slice(0, 32768);
  for (let i = 0; i < count; i++) {
    const directory = path.join(root, 'Bench', `F${i % folders}`, 'a/b/c/d');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `Note${i}.md`), body);
  }
  fs.writeFileSync(path.join(root, 'Bench', 'short.md'), 'Short editable note.');
  fs.writeFileSync(path.join(root, 'Bench', 'long.md'), Array.from({ length: 1000 }, (_, i) => `## Section ${i}\n\nParagraph **bold** and [link](https://example.com).\n\n`).join(''));
  const db = require(path.join(repo, 'database'));
  const routes = require(path.join(repo, 'lib/knowledge/routes'));
  const knowledge = routes.serviceFor(db).knowledge;
  await knowledge.backgroundReady;
  console.log(`Indexed ${count} documents`);
  const server = await require(path.join(repo, 'server')).startServer(0, '127.0.0.1');
  const win = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code).catch(error => { console.error('Renderer evaluation failed:', code); throw error; });
  async function until(condition) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (await js(condition)) return; await pause(5); }
    throw new Error(`Timeout: ${condition}`);
  }
  const result = { documents: count, samples, bodyBytes: 32768, platform: process.platform, arch: process.arch, electron: process.versions.electron, backend: {}, navigation: [], editing: [] };
  try {
    for (const [name, operation] of Object.entries({
      tree: () => routes.treeForDocuments(knowledge.directoryCategories(), knowledge.listDocumentTreeLocations(), db, { hideAppBundles: true }),
      folder: () => knowledge.listDocumentPage({ knowledgeBase: 'Bench', folder: 'F0/a/b/c/d' }, { limit: 60, pinSort: true }),
    })) {
      operation(); operation(); const times = [];
      for (let i = 0; i < samples; i++) { const start = performance.now(); operation(); times.push(performance.now() - start); }
      result.backend[name] = stats(times);
    }
    await win.loadURL(`http://127.0.0.1:${server.address().port}/#knowledge`);
    await until('!!document.querySelector("[data-knowledge-base-open=Bench]")');
    await js(`window.perfRequests=[];window.perfTasks=[];window.perfReplacements=0;
      new PerformanceObserver(list=>perfTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask'});
      const originalFetch=window.fetch;window.fetch=async(...args)=>{const start=performance.now();const response=await originalFetch(...args);perfRequests.push({url:String(args[0]),start,duration:performance.now()-start});return response;};
      new MutationObserver(records=>{perfReplacements+=records.filter(r=>r.removedNodes.length>0).length}).observe(document.querySelector('#knowledgeDocumentList'),{childList:true});void 0;`);
    for (let i = 0; i < samples; i++) {
      const folder = `F${i % folders}/a/b/c/d`;
      const start = performance.now();
      await js(`location.hash=${JSON.stringify('#knowledge?base=Bench&folder=' + encodeURIComponent(folder))}`);
      await until(`document.querySelector('#knowledgeBreadcrumb')?.textContent.includes('F${i % folders}') && [...document.querySelectorAll('[data-document-open] strong')].some(node=>node.textContent === 'Note${i % folders}')`);
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      result.navigation.push(performance.now() - start);
    }
    console.log('Navigation measured');
    for (const kind of ['short', 'long']) for (const mode of ['edit', 'split']) {
      const record = [...knowledge.workspace.records.values()].find(item => item.relativePath === `Bench/${kind}.md`);
      await js(`location.hash=${JSON.stringify('#knowledge/' + encodeURIComponent(record.id))}`);
      await until(`document.querySelector('#documentTitle').value===${JSON.stringify(kind)}`);
      await js(`document.querySelector('[data-editor-mode=${mode}]').click()`);
      await pause(1000);
      const input = await js(`(async()=>{const times=[];const editor=document.querySelector('#documentContent');editor.focus();
        for(let i=0;i<${samples};i++){const start=performance.now();editor.value+='x';editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));times.push(performance.now()-start);}return times;})()`);
      await until("document.querySelector('#documentSaveState').textContent==='已保存'");
      const saves = [];
      const from = await js('performance.now()');
      for (let i = 0; i < Math.ceil(samples / 4); i++) {
        const start = performance.now();
        await js("{const e=document.querySelector('#documentContent');e.value+='y';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'y'}));}");
        await until("document.querySelector('#documentSaveState').textContent==='已保存'");
        saves.push(performance.now() - start);
      }
      const tasks = await js(`perfTasks.filter(t=>t.start>=${from})`);
      const content = await js("document.querySelector('#documentContent').value");
      assert.equal((await knowledge.getDocument(record.id)).content, content);
      result.editing.push({ kind, mode, inputToTwoFrames: stats(input), autosave: stats(saves), longTasks: tasks });
      console.log(`Editing ${kind}/${mode} measured`);
    }
    result.navigation = stats(result.navigation);
    result.requests = await js('perfRequests');
    result.listRemovals = await js('perfReplacements');
    result.longTasks = await js('perfTasks');
    result.limitations = 'Warm isolated files; synthetic input events, two-frame presentation proxy, hidden Electron window. Not hardware keyboard latency or packaged cold startup. Autosave includes the intentional 800ms delay.';
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ backend: result.backend, navigation: result.navigation, editing: result.editing.map(({ longTasks, ...item }) => ({ ...item, longTasks: longTasks.length })) }));
  } finally {
    win.destroy(); await routes.shutdownKnowledgeServices();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    db.close();
  }
}
app.whenReady().then(main).then(() => { fs.rmSync(temporary, { recursive: true, force: true }); app.exit(0); })
  .catch(error => { console.error(error); fs.rmSync(temporary, { recursive: true, force: true }); app.exit(1); });
