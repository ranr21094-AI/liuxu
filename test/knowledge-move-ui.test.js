const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('move dialog supports root and nested targets, preserves failed selections, prevents duplicate submits and returns focus', async () => {
  const dom = new JSDOM('<body><input id="knowledgeSearch"><div data-document-open="note:1"><button class="knowledge-row-more">⋯</button><button id="move">移动到</button></div></body>');
  const { initKnowledgeMove } = await import('../public/js/app/knowledge-move.js');
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let finish, calls = 0;
  const doc = dom.window.document;
  const ui = initKnowledgeMove({ doc, getBases: () => [{ name: 'A', folders: [{ name: 'a', path: 'a', children: [{ name: 'b', path: 'a/b', children: [] }] }] }, { name: 'B', folders: [] }],
    getDocument: () => ({ id: 'note:1', knowledgeBase: 'A', folderPath: 'a', title: '笔记' }),
    move: () => { calls++; return new Promise((resolve, reject) => { finish = { resolve, reject }; }); },
  });
  try {
    ui.open('note:1', doc.getElementById('move'));
    const dialog = doc.querySelector('dialog'), form = dialog.querySelector('form'), button = form.querySelector('[type="submit"]');
    assert.equal(button.disabled, true);
    assert.equal(form.elements.folder.tagName, 'INPUT');
    form.querySelector('[data-folder-browse]').click();
    assert.deepEqual([...dialog.querySelectorAll('[data-folder-choice]')].map(el => el.dataset.folderChoice), ['', 'a']);
    form.elements.base.dispatchEvent(new dom.window.Event('change'));
    form.elements.base.value = 'B';form.elements.base.dispatchEvent(new dom.window.Event('change'));
    assert.equal(form.elements.folder.value, ''); assert.equal(button.disabled, false);
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));assert.equal(calls, 1);
    assert.equal(button.disabled, true);finish.reject(new Error('版本冲突'));await tick();
    assert.equal(dialog.open, true);assert.equal(form.elements.base.value, 'B');assert.match(dialog.textContent, /版本冲突/);assert.equal(button.disabled, false);
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));finish.resolve();await tick();
    assert.equal(dialog.open, false);assert.equal(doc.activeElement.className, 'knowledge-row-more');
  } finally { dom.window.close(); }
});

test('document move saves the latest active draft before sending its version and stops on save failure', async () => {
  const source = fs.readFileSync('public/js/workbench.js', 'utf8');
  const fn = source.slice(source.indexOf('async function moveKnowledgeItem('), source.indexOf('async function loadDocuments(', source.indexOf('async function moveKnowledgeItem(')));
  const state = { activeDocument: { id: 'note:1', version: 1, knowledgeBase: 'A', folderPath: '' }, documents: [] };
  let save = false, requests = [];
  const c = vm.createContext({ state, flushPendingSaves: async () => { if(save)state.activeDocument.version=3;return save; },
    apiFetch: async (url, options) => { requests.push({url,body:JSON.parse(options.body)});return { ok: true, json: async () => ({...state.activeDocument,knowledgeBase:'B'}) }; },
    renderActiveDocument: async d => { state.activeDocument=d; },loadDocuments: async()=>{},showToast() {},
  });vm.runInContext(fn,c);
  await assert.rejects(c.moveKnowledgeItem({type:'document',id:'note:1'},{knowledgeBase:'B',folderPath:''}), /尚未保存/);assert.equal(requests.length,0);
  save=true;await c.moveKnowledgeItem({type:'document',id:'note:1'},{knowledgeBase:'B',folderPath:''});
  assert.equal(requests[0].body.baseVersion,3);assert.equal(state.activeDocument.id,'note:1');assert.equal(state.activeDocument.knowledgeBase,'B');
  state.activeDocument={id:'file:2',sourceType:'file',version:1,knowledgeBase:'A',folderPath:''};
  await c.moveKnowledgeItem({type:'document',id:'file:2'},{knowledgeBase:'B',folderPath:''});
  assert.match(requests[1].url,/file%3A2$/);assert.equal(requests[1].body.baseVersion,3);assert.equal(state.activeDocument.id,'file:2');
});

test('cascading folder picker shows one level, expands on hover and accepts only existing relative paths', async () => {
  const dom=new JSDOM('<body><button id="origin">菜单</button></body>');
  const { initKnowledgeMove }=await import('../public/js/app/knowledge-move.js');
  const { normalizeRelativeFolder }=await import('../public/js/app/knowledge-folder-picker.js');
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  let destination;
  const doc=dom.window.document;
  const ui=initKnowledgeMove({doc,getBases:()=>[{name:'A',folders:[{name:'a',path:'a',children:[{name:'b',path:'a/b',children:[]}]}]}],getDocument:()=>({id:'note:1',knowledgeBase:'A',folderPath:''}),move:async(_,target)=>{destination=target;}});
  try {
    ui.open('note:1',doc.getElementById('origin'));
    const form=doc.querySelector('form'), input=form.elements.folder, submit=form.querySelector('[type="submit"]');
    form.querySelector('[data-folder-browse]').click();
    const popup=doc.querySelector('.knowledge-folder-picker');
    assert.equal(popup.querySelectorAll('.knowledge-folder-column').length,1);
    const row=popup.querySelector('.knowledge-folder-choice-row');const enter=new dom.window.Event('pointerenter');Object.defineProperty(enter,'pointerType',{value:'mouse'});row.dispatchEvent(enter);
    await new Promise(resolve=>setTimeout(resolve,180));assert.equal(popup.querySelectorAll('.knowledge-folder-column').length,2);
    assert.equal(popup.querySelector('.knowledge-folder-column:last-child [data-folder-choice]').dataset.folderChoice,'a/b');
    const escape=new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});popup.querySelector('[data-folder-choice]').dispatchEvent(escape);
    assert.equal(popup.hidden,true);assert.equal(doc.querySelector('dialog').open,true);
    for(const value of ['/a/b','../b','C:\\a','unknown']){input.value=value;input.dispatchEvent(new dom.window.Event('input'));assert.equal(submit.disabled,true);}
    input.value='./a/b';input.dispatchEvent(new dom.window.Event('input'));assert.equal(submit.disabled,false);
    form.dispatchEvent(new dom.window.Event('submit',{cancelable:true,bubbles:true}));await tick();assert.deepEqual(destination,{knowledgeBase:'A',folderPath:'a/b'});
    assert.equal(normalizeRelativeFolder('a\\b'),'a/b');assert.equal(normalizeRelativeFolder(''), '');
  } finally {dom.window.close();}
});
