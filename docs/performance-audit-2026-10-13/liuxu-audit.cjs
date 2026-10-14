const fs=require('fs'),os=require('os'),path=require('path'),{performance}=require('perf_hooks');
const repo=path.resolve(__dirname,'../..'),count=Number(process.argv[2]||1000);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'liuxu-audit-'));process.env.DATA_DIR=root;process.env.AI_SECRETS_KEY_FILE=path.join(root,'key');
const {createDatabase}=require(repo+'/database'),{createKnowledgeService}=require(repo+'/lib/knowledge/documents'),{createSearchIndex}=require(repo+'/lib/knowledge/search'),{serializeMarkdown,fileFingerprint}=require(repo+'/lib/knowledge/folder-sync'),{filterDocuments}=require(repo+'/lib/knowledge/filters'),{createAgentStore}=require(repo+'/lib/agent/store');
const db=createDatabase(root),k=createKnowledgeService(db,{startFolderSync:false}),s=createSearchIndex(k),out={count,bodyChars:0,metrics:{}};
const percentile=(a,p)=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];
async function bench(name,fn,n=12){const a=[];let v;for(let i=0;i<n;i++){const t=performance.now();v=await fn(i);a.push(performance.now()-t);}out.metrics[name]={p50:+percentile(a,.5).toFixed(2),p95:+percentile(a,.95).toFixed(2),samples:n};return v;}
(async()=>{try{
const content=('# 标题\n\n知识库性能验证 alpha beta gamma. '+ '这是用于验证文件同步和搜索的正文，测试日常笔记内容以及增长规模。alpha beta gamma. '.repeat(20));out.bodyChars=content.length;
const docs=[],ins=db.sqlite.prepare('INSERT INTO knowledge_documents(id,body) VALUES (?,?)');
db.sqlite.transaction(()=>{for(let i=1;i<=count;i++){const d={id:'note:'+i,sourceType:'note',sourceRef:'note:'+i,title:'性能文档 '+i,content:content+' unique'+i,collectionPath:'审查/分组'+(i%20)+'/子目录',knowledgeBase:'审查',folderPath:'分组'+(i%20)+'/子目录',tags:[],visibility:'standard',status:'active',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',version:1,documentDate:'2026-01-01',documentRole:'normal',fileMeta:null};docs.push(d);ins.run(d.id,JSON.stringify(d));}db.sqlite.prepare("INSERT INTO meta(key,value) VALUES ('next_note_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(''+(count+1));db.sqlite.prepare('UPDATE knowledge_index_state SET version=version+1 WHERE id=1').run();})();
await bench('coldSearch',()=>s.search('知识库',{limit:20}),1);await bench('warmSearch',()=>s.search('知识库',{limit:20}));
await bench('allDocuments',()=>k.allDocuments());await bench('listPage60',()=>filterDocuments(k.allDocuments(),{}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,60));
await bench('quickOpen20',()=>k.quickOpen({query:'性能',limit:20}));await bench('searchDocuments20',()=>s.searchDocuments('知识库',{}, {limit:20}));
await bench('saveOnly',i=>{const d=k.getDocument('note:1');return k.updateDocument(d.id,{content:content+' saved'+i,baseVersion:d.version});});
await bench('saveThenSearch',i=>{const d=k.getDocument('note:1');k.updateDocument(d.id,{content:content+' reindex'+i,baseVersion:d.version});return s.search('知识库',{limit:20});},8);
out.indexBytes=fs.statSync(path.join(root,'knowledge-index.json')).size;
const folder=path.join(root,'folder');fs.mkdirSync(folder);k.folderSync.config={...k.folderSync.config,enabled:true,rootPath:folder};fs.writeFileSync(k.folderSync.configPath,JSON.stringify(k.folderSync.config));
for(const d0 of docs){const d=k.getDocument(d0.id),relative=d.collectionPath+'/doc'+d.id.split(':')[1]+'.md',full=path.join(folder,relative);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,serializeMarkdown(d));k.folderSync.manifest[d.id]={relativePath:relative,fingerprint:fileFingerprint(full),sourceType:'note',parentDocumentId:null};}
// Add filename-only files and a modest attachment without requesting extraction.
for(let i=0;i<count;i++)fs.writeFileSync(path.join(folder,'审查','分组'+(i%20),'other'+i+'.bin'),'attachment');fs.writeFileSync(path.join(folder,'审查','large.bin'),Buffer.alloc(8*1024*1024));
k.folderSync.persistManifest();await bench('scanFiles',()=>k.folderSync.scanFiles());await bench('nameOnlyOneFolder',()=>k.folderSync.listNameOnlyEntries({knowledgeBase:'审查',folderPath:'分组1'}));
let maxLag=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last-5);last=now;},5);
await bench('unchangedFolderSync',()=>k.folderSync.syncNow(),4);await new Promise(r=>setTimeout(r,20));clearInterval(timer);out.maxSyncEventLoopLagMs=+maxLag.toFixed(2);out.syncReport=k.folderSync.state.report;
// Existing unchanged Markdown files should be skipped cheaply, but count actual reads.
let reads=0,bytes=0;const original=fs.readFileSync;fs.readFileSync=function(file,...args){const v=original.call(fs,file,...args);if(String(file).startsWith(folder)&&String(file).endsWith('.md')){reads++;bytes+=Buffer.byteLength(v);}return v;};try{await k.folderSync.syncNow();}finally{fs.readFileSync=original;}out.unchangedMarkdownReads={reads,bytes};
await bench('saveWithFolderSync',i=>{const d=k.getDocument('note:1');return k.updateDocument(d.id,{content:content+' folder'+i,baseVersion:d.version});},8);
const a=createAgentStore(db),session=a.createSession('长会话');session.messages=Array.from({length:1000},(_,i)=>({role:i%2?'assistant':'user',content:content}));a.saveSession(session);await bench('sessionRead1000',()=>a.getSession(session.id));await bench('sessionSave1000',()=>a.saveSession(session));
const details=a.getSession(session.id);out.sessionResponseBytes=Buffer.byteLength(JSON.stringify(details));out.rssMb=+(process.memoryUsage().rss/1048576).toFixed(2);
fs.writeFileSync('/private/tmp/liuxu-audit-'+count+'.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
}finally{k.folderSync.stop();db.close();require(repo+'/lib/db/connection').closeAllDatabases();fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
