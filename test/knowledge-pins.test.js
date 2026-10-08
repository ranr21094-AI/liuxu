const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createTempDatabase}=require('./db-temp');
const {createKnowledgeService}=require('../lib/knowledge/documents');
const {registerKnowledgeRoutes,serviceFor,invalidateKnowledgeCache,treeForDocuments}=require('../lib/knowledge/routes');
const {JSDOM}=require('jsdom');
const {serializeMarkdown}=require('../lib/knowledge/folder-sync');
function setup(t){const {db,dir}=createTempDatabase(t,'knowledge-pins-');const knowledge=createKnowledgeService(db,{startFolderSync:false});t.after(()=>knowledge.folderSync.stop());db.addCategory('项目');db.addCategory('分支','项目');db.addCategory('子层','项目/分支');db.addCategory('目标');return {db,dir,knowledge};}
const folder=(db,name)=>{let node={sub:db.getAllCategories(true,true)};for(const segment of name.split('/'))node=node.sub.find(n=>n.name===segment);return node};
test('pins do not change content versions, history, timestamps or disk; repeated operations are idempotent',t=>{
 const {db,dir,knowledge}=setup(t);const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'pins-folder-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const note=knowledge.createNote({title:'笔记',content:'正文',knowledgeBase:'项目'}).document;knowledge.folderSync.migrateAll({rootPath:root});
 const before=knowledge.getDocument(note.id),file=knowledge.folderSync.localPathFor(before),bytes=fs.readFileSync(file),time=fs.statSync(file).mtimeMs;
 const pinned=knowledge.setDocumentPinned(note.id,true);assert(pinned.pinnedAt);assert.equal(knowledge.setDocumentPinned(note.id,true).pinnedAt,pinned.pinnedAt);
 const after=knowledge.getDocument(note.id);assert.equal(after.version,before.version);assert.equal(after.updatedAt,before.updatedAt);assert.equal(after.content,before.content);assert.equal(knowledge.listRevisions(note.id).revisions.length,0);
 assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(fs.statSync(file).mtimeMs,time);
 assert.equal(knowledge.setDocumentPinned(note.id,false).pinnedAt,'');assert.equal(knowledge.setDocumentPinned(note.id,false).pinnedAt,'');
 const rootPin=db.setCategoryPinned('项目',true);assert.equal(db.setCategoryPinned('项目',true).pinnedAt,rootPin.pinnedAt);assert.equal(folder(db,'项目').pinnedAt,rootPin.pinnedAt);
});
test('renames retain pins, folder moves clear only their own pin, document moves/archive clear pins',t=>{
 const {db,knowledge}=setup(t);db.setCategoryPinned('项目',true);db.setCategoryPinned('项目/分支',true);const childPin=db.setCategoryPinned('项目/分支/子层',true).pinnedAt;
 const note=knowledge.createNote({title:'内部笔记',knowledgeBase:'项目',folderPath:'分支/子层'}).document;const pin=knowledge.setDocumentPinned(note.id,true).pinnedAt;
 assert(db.renameCategory('项目/分支','改名').success);knowledge.rewriteCollectionPath('项目/分支','项目/改名');assert(folder(db,'项目/改名').pinnedAt);assert.equal(knowledge.getDocument(note.id).pinnedAt,pin);
 const move=db.moveCategory('项目/改名','目标');knowledge.rewriteCollectionPath(move.oldPath,move.newPath);assert.equal(folder(db,'目标/改名').pinnedAt,undefined);assert.equal(folder(db,'目标/改名/子层').pinnedAt,childPin);assert.equal(knowledge.getDocument(note.id).pinnedAt,pin);
 let current=knowledge.getDocument(note.id);knowledge.updateDocument(note.id,{knowledgeBase:'目标',folderPath:'',baseVersion:current.version});assert.equal(knowledge.getDocument(note.id).pinnedAt,undefined);
 knowledge.setDocumentPinned(note.id,true);knowledge.archiveDocument(note.id);assert.equal(knowledge.getDocument(note.id).pinnedAt,undefined);knowledge.restoreDocument(note.id);assert.equal(knowledge.getDocument(note.id).pinnedAt,undefined);
});
test('pins survive JSON and native ZIP backup/restart, history excludes them; external moves clear only moved documents',async(t)=>{
 const {db,dir,knowledge}=setup(t);const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'pins-folder-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 db.setCategoryPinned('项目',true);db.setCategoryPinned('项目/分支',true);const note=knowledge.createNote({title:'同步笔记',content:'正文',knowledgeBase:'项目',folderPath:'分支'}).document;knowledge.folderSync.migrateAll({rootPath:root});
 const pin=knowledge.setDocumentPinned(note.id,true).pinnedAt;const named=knowledge.createNamedRevision(note.id,{name:'内容快照',baseVersion:knowledge.getDocument(note.id).version});assert.equal(named.revision.snapshot.pinnedAt,undefined);
 const backup=db.backup();db.setCategoryPinned('项目',false);knowledge.setDocumentPinned(note.id,false);db.restore(backup);db.resetCache();assert(folder(db,'项目').pinnedAt);assert(folder(db,'项目/分支').pinnedAt);assert.equal(knowledge.getDocument(note.id).pinnedAt,pin);
 const {exportWorkspace,restoreWorkspace}=require('../lib/workspace/zip');const zip=await exportWorkspace(db);knowledge.setDocumentPinned(note.id,false);await restoreWorkspace(db,zip);assert.equal(createKnowledgeService(db,{startFolderSync:false}).getDocument(note.id).pinnedAt,pin);
 const restored=createKnowledgeService(db,{startFolderSync:false});t.after(()=>restored.folderSync.stop());const current=restored.getDocument(note.id);restored.folderSync.adapter.upsertFromDisk(note.id,{...current,folderPath:'别处',collectionPath:'项目/别处'});assert.equal(restored.getDocument(note.id).pinnedAt,undefined);
});
test('unified pinned rows mix folders and documents, retain unpinned order and escape button targets',async()=>{
 const {arrangePinnedRows,pinActionHtml,mergeDocumentPages}=await import('../public/js/knowledge/pins.js');const dom=new JSDOM('<div id="list"><div data-id="folder" data-pinned-at="2026-10-08T00:00:01.000Z"></div><div data-id="plain-folder"></div><div data-id="doc" data-pinned-at="2026-10-08T00:00:02.000Z"></div><div data-id="plain-doc"></div></div>');const list=dom.window.document.querySelector('#list');arrangePinnedRows(list);assert.deepEqual([...list.querySelectorAll('[data-id]')].map(n=>n.dataset.id),['doc','folder','plain-folder','plain-doc']);assert.deepEqual([...list.querySelectorAll('.knowledge-pin-section')].map(n=>n.textContent),['置顶','当前层级']);
 assert.deepEqual(mergeDocumentPages([{id:'note:1',title:'旧'},{id:'note:2'}],[{id:'note:1',title:'新'},{id:'note:3'}]),[{id:'note:1',title:'新'},{id:'note:2'},{id:'note:3'}]);
 assert(pinActionHtml({kind:'folder',target:'"<x>',pinnedAt:'',escape:v=>v.replace(/"/g,'&quot;').replace(/</g,'&lt;')}).includes('&quot;&lt;x>'));dom.window.close();
});
test('pin API protects diary, validates targets, returns directory metadata and sorts before pagination only in normal browsing',async(t)=>{
 const {db,knowledge}=setup(t);const express=require('express'),app=express();app.use(express.json());registerKnowledgeRoutes(app,{db,hasDiaryAccess:req=>req.headers['x-unlocked']==='yes',rejectLockedDiary:res=>res.status(403).json({error:'locked'})});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(async()=>{invalidateKnowledgeCache(db.dataDir);await new Promise(r=>server.close(r))});const base=`http://127.0.0.1:${server.address().port}`;
 const request=async body=>{const response=await fetch(base+'/api/knowledge/pin',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()}};
 const notes=[];for(let i=0;i<65;i++)notes.push(knowledge.createNote({title:'笔记 '+i,content:'正文',knowledgeBase:'项目'}).document);
 const result=await request({kind:'document',id:notes[0].id,pinned:true});assert.equal(result.status,200);
 let page=await(await fetch(base+'/api/knowledge/documents?knowledgeBase=项目&folder=&limit=2')).json();assert.equal(page.documents[0].id,notes[0].id);assert.equal(page.documents[0].pinnedAt,result.body.pinnedAt);assert.equal(page.nextCursor,'2');
 page=await(await fetch(base+'/api/knowledge/documents?knowledgeBase=项目&folder=&tag=missing')).json();assert.equal(page.total,0);
 const all=await(await fetch(base+'/api/knowledge/documents?knowledgeBase=项目&folder=&q=正文&limit=100')).json();assert.notEqual(all.documents[0].id,notes[0].id);
 assert.equal((await request({kind:'document',id:notes[0].id,pinned:true})).body.pinnedAt,result.body.pinnedAt);
 assert.equal((await request({kind:'folder',path:'项目/分支',pinned:true})).status,200);assert.equal((await request({kind:'knowledgeBase',path:'项目',pinned:true})).status,200);
 const tree=await(await fetch(base+'/api/knowledge/tree')).json();assert(tree.knowledgeBases.find(b=>b.name==='项目').pinnedAt);assert(tree.knowledgeBases.find(b=>b.name==='项目').folders[0].pinnedAt);
 for(const body of [{kind:'folder',path:'项目/不存在',pinned:true},{kind:'document',id:'note:99999',pinned:true}])assert.equal((await request(body)).status,404);
 assert.equal((await request({kind:'folder',path:'日记/私密',pinned:true})).status,403);
 const diary=knowledge.createNote({title:'私密',knowledgeBase:'日记'},{diaryUnlocked:true}).document;assert.equal((await request({kind:'document',id:diary.id,pinned:true})).status,403);
 for(const body of [{kind:'bad',pinned:true},{kind:'document',id:notes[0].id,pinned:'yes'},{kind:'folder',path:'项目/../x',pinned:true}])assert.equal((await request(body)).status,400);
});
test('mindmaps and imported files pin normally; stale parent targets cannot pin moved documents',t=>{
 const {knowledge}=setup(t);const map=knowledge.createNote({title:'导图',knowledgeBase:'项目',documentRole:'mindmap',content:JSON.stringify({version:1,rootId:'r',nodes:[{id:'r',text:'中心',x:0,y:0}],edges:[],canvas:{width:300,height:300}})}).document;
 const file=knowledge.saveImportedFile({buffer:Buffer.from('原始档案'),filename:'档案.txt',mimeType:'text/plain',text:'原始档案',knowledgeBase:'项目'}).document;
 for(const document of [map,file]){const before=knowledge.getDocument(document.id);assert(knowledge.setDocumentPinned(document.id,true,{collectionPath:before.collectionPath}).pinnedAt);assert.equal(knowledge.getDocument(document.id).version,before.version);knowledge.updateDocument(document.id,{knowledgeBase:'目标',baseVersion:before.version});assert.equal(knowledge.setDocumentPinned(document.id,true,{collectionPath:before.collectionPath}).status,409);assert.equal(knowledge.getDocument(document.id).pinnedAt,undefined)}
});
test('JSON pin metadata merges safely and ignores reused document IDs with a different identity',t=>{
 const {db,knowledge}=setup(t);const note=knowledge.createNote({title:'笔记',knowledgeBase:'项目'}).document;knowledge.setDocumentPinned(note.id,true);db.setCategoryPinned('项目/分支',true);const backup=db.backup();knowledge.setDocumentPinned(note.id,false);db.setCategoryPinned('项目/分支',false);assert(db.restore(backup,'merge').success);assert(knowledge.getDocument(note.id).pinnedAt);assert(folder(db,'项目/分支').pinnedAt);
 knowledge.setDocumentPinned(note.id,false);const altered=structuredClone(backup);altered.knowledgePins.find(entry=>entry.id===note.id).createdAt='不同文档';assert(db.restore(altered).success);assert.equal(knowledge.getDocument(note.id).pinnedAt,undefined);
});
