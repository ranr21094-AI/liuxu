const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'liuxu-images-electron-'));
process.env.DATA_DIR=dataDir;process.env.AI_SECRETS_KEY_FILE=path.join(dataDir,'key');process.env.LIUXU_DESKTOP='0';
async function wait(wc,code,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await wc.executeJavaScript(code))return;await new Promise(r=>setTimeout(r,60))}throw new Error('Timed out: '+label)}
async function main(){
 const db=require('../database'), knowledge=require('../lib/knowledge/documents').createKnowledgeService(db);
 const note=knowledge.createNote({title:'图片调整验证',content:'图片调整示例',knowledgeBase:'隔离验证'}).document;
 const other=knowledge.createNote({title:'另一篇笔记',content:'不得插入错位置',knowledgeBase:'隔离验证'}).document;
 const server=await require('../server').startServer(0,'127.0.0.1');
 const win=new BrowserWindow({width:1280,height:850,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}),wc=win.webContents;
 const execute=wc.executeJavaScript.bind(wc);wc.executeJavaScript=async code=>{try{return await execute(code)}catch(error){console.error('Failed renderer expression:',code);throw error}};
 const upload=`(async()=>{const c=document.createElement('canvas');c.width=640;c.height=320;const x=c.getContext('2d');x.fillStyle='#dce6d9';x.fillRect(0,0,640,320);x.fillStyle='#34513d';x.font='30px sans-serif';x.fillText('留序 · 图片尺寸调整',45,165);const b=await new Promise(r=>c.toBlob(r,'image/png'));const dt=new DataTransfer();dt.items.add(new File([b],'中文图片.png',{type:'image/png'}));const input=document.querySelector('#documentImageInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`;
 const saved="document.querySelector('#documentSaveState').textContent.includes('已保存')";
 const preview="document.querySelector('[data-editor-mode=preview]').click()";
 const choose="document.querySelector('#documentPreview img').click()";
 try{
  await win.loadURL(`http://127.0.0.1:${server.address().port}/#knowledge/${encodeURIComponent(note.id)}`);
  await wait(wc,"document.querySelector('#documentTitle').value==='图片调整验证'",'note');
  await wc.executeJavaScript(upload);await wait(wc,"document.querySelector('#documentContent').value.includes('<img')&&"+saved,'HTML upload and save');
  assert.match(knowledge.getDocument(note.id).content,/<img src=/);
  await wc.executeJavaScript(preview);await wait(wc,"document.querySelector('#documentPreview img')?.naturalWidth===640",'original image');
  await wc.executeJavaScript(choose+";const input=document.querySelector('.note-image-size-bar input');input.value=300;document.querySelector('[data-size=pixels]').click()");
  await wait(wc,"document.querySelector('#documentContent').value.includes('width=\"300\"')&&"+saved,'pixel save');
  assert.match(knowledge.getDocument(note.id).content,/width="300"/);
  await wc.executeJavaScript(choose+";const select=document.querySelector('.note-image-size-bar select');select.value='50%';select.dispatchEvent(new Event('change'))");
  await wait(wc,"document.querySelector('#documentContent').value.includes('width:50%')&&"+saved,'percent save');
  await wc.executeJavaScript(choose);
  let point=await wc.executeJavaScript("(()=>{const r=document.querySelector('.note-image-resize-handle').getBoundingClientRect();return {x:Math.round(r.x+14),y:Math.round(r.y+14)}})()");
  wc.sendInputEvent({type:'mouseMove',...point});await new Promise(r=>setTimeout(r,60));
  wc.sendInputEvent({type:'mouseDown',button:'left',...point});await new Promise(r=>setTimeout(r,40));wc.sendInputEvent({type:'mouseMove',x:point.x+60,y:point.y});await new Promise(r=>setTimeout(r,40));wc.sendInputEvent({type:'mouseUp',button:'left',x:point.x+60,y:point.y});
  await wait(wc,"/width=\"\\d+\"/.test(document.querySelector('#documentContent').value)&&"+saved,'native drag');
  await wc.executeJavaScript(choose);const before=await wc.executeJavaScript("document.querySelector('#documentContent').value");
  await wc.executeJavaScript("const h=document.querySelector('.note-image-resize-handle');h.dispatchEvent(new PointerEvent('pointerdown',{pointerId:22,clientX:200,bubbles:true}));h.dispatchEvent(new PointerEvent('pointermove',{pointerId:22,clientX:280,bubbles:true}));h.dispatchEvent(new PointerEvent('pointercancel',{pointerId:22,bubbles:true}));");
  assert.equal(await wc.executeJavaScript("document.querySelector('#documentContent').value"),before);
  await wc.executeJavaScript(choose);const shots=path.join(__dirname,'../docs/images');fs.mkdirSync(shots,{recursive:true});await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(shots,'note-images-desktop.png'),(await wc.capturePage()).toPNG());
  win.setSize(390,844);await new Promise(r=>setTimeout(r,180));await wc.executeJavaScript(choose);await new Promise(r=>setTimeout(r,100));
  assert(await wc.executeJavaScript("document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.note-image-size-bar').getBoundingClientRect().right<=innerWidth"));
  fs.writeFileSync(path.join(shots,'note-images-mobile.png'),(await wc.capturePage()).toPNG());
  await wc.executeJavaScript("document.querySelector('[data-editor-mode=edit]').click()");
  await wc.executeJavaScript(upload.replace("const input=document.querySelector('#documentImageInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));","document.querySelector('#documentContent').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));"));
  await wait(wc,"(document.querySelector('#documentContent').value.match(/<img/g)||[]).length===2&&"+saved,'clipboard HTML image');
  await wc.executeJavaScript(`location.hash='#knowledge/${encodeURIComponent(other.id)}'`);await wait(wc,"document.querySelector('#documentTitle').value==='另一篇笔记'",'switch');
  assert.equal(await wc.executeJavaScript("Boolean(document.querySelector('.note-image-size-bar'))"),false);
  // Return, delay upload response, switch away, and ensure upload cannot write the new document.
  await wc.executeJavaScript(`location.hash='#knowledge/${encodeURIComponent(note.id)}'`);await wait(wc,"document.querySelector('#documentTitle').value==='图片调整验证'",'return');
  await wc.executeJavaScript("window.originalImageFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.originalImageFetch(...args);if(String(args[0]).includes('/api/upload')){window.uploadArrived=true;await new Promise(resolve=>window.finishUpload=resolve)}return response};undefined");
  await wc.executeJavaScript(upload);await wait(wc,'window.uploadArrived','pending upload');
  await wc.executeJavaScript(`location.hash='#knowledge/${encodeURIComponent(other.id)}'`);await wait(wc,"document.querySelector('#documentTitle').value==='另一篇笔记'",'switch pending upload');await wc.executeJavaScript('window.finishUpload();window.fetch=window.originalImageFetch;undefined');await new Promise(r=>setTimeout(r,150));
  assert.equal(await wc.executeJavaScript("document.querySelector('#documentContent').value"),'不得插入错位置');assert.equal(knowledge.getDocument(other.id).content,'不得插入错位置');
  console.log('Note image Electron checks passed: HTML upload/paste, protected preview, pixel/percent save, native drag, cancellation, mobile layout, cleanup and stale upload.');
 }finally{win.destroy();knowledge.folderSync.stop();await new Promise(r=>server.close(r));db.close();fs.rmSync(dataDir,{recursive:true,force:true})}
}
app.whenReady().then(main).then(()=>app.quit()).catch(error=>{console.error(error);fs.rmSync(dataDir,{recursive:true,force:true});app.exit(1)});
