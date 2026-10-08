const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const load = () => import('../public/js/knowledge/note-images.js');
test('HTML insertion escapes attributes and resizing converts only the chosen occurrence', async () => {
  const { imageHtml, imageTokens, resizedImage } = await load();
  assert.equal(imageHtml('/图&片.png', 'a"<b>'), '<img src="/图&amp;片.png" alt="a&quot;&lt;b&gt;">');
  const source = '![一](./图.png)\n![二](./图.png)\n`![代码](./x.png)`\n```html\n<img src="./示例.png">\n```';
  const tokens = imageTokens(source); assert.equal(tokens.length, 2);
  const html = resizedImage(tokens[1], '50%'); assert.match(html, /style="width:50%;height:auto"/);
  assert.equal(source.slice(0,tokens[1].start), '![一](./图.png)\n');
  const token = imageTokens('<img src="./x.png" width="400" height="200" style="width:50%" alt="图">')[0];
  assert.equal(resizedImage(token, 300), '<img src="./x.png" alt="图" width="300">');
  assert.equal(resizedImage(token, 'auto'), '<img src="./x.png" alt="图">');
  for (const size of [0, -20, 10001, '101%', 'expression(x)', '1;position:fixed']) assert.throws(()=>resizedImage(token,size));
});
async function fixture() {
 const dom = new JSDOM('<div id="preview"><img src="x.png" alt="一"><img src="x.png" alt="二"></div>', {pretendToBeVisual:true});
 const { bindNoteImageSizing } = await load(); const doc=dom.window.document, host=doc.querySelector('#preview');
 let source='![一](x.png)\n![二](x.png)', id='note:1', version=1, enabled=true, changes=[], original=0;
 const cleanup=bindNoteImageSizing({host,getSource:()=>source,getDocumentId:()=>id,getVersion:()=>version,canEdit:()=>enabled,onChange:value=>{source=value;changes.push(value)},openOriginal:()=>original++});
 return {dom,doc,host,changes,get source(){return source},setSource:value=>source=value,setId:value=>id=value,setVersion:value=>version=value,lock:()=>enabled=false,original:()=>original,close:()=>{cleanup();dom.window.close()}};
}
test('size UI binds repeated images and rejects stale text, document switches and locks',async()=>{
 const f=await fixture();try{
  f.host.querySelectorAll('img')[1].click(); f.doc.querySelector('select').value='50%';f.doc.querySelector('select').dispatchEvent(new f.dom.window.Event('change'));
  assert.match(f.source,/^!\[一\]\(x.png\)\n<img src="x.png" alt="二" style="width:50%;height:auto">$/);
  f.host.querySelector('img').click(); assert.equal(f.doc.querySelector('.note-image-size-bar'),null);
 }finally{f.close()}
 for(const change of [f=>f.setSource('新正文'),f=>f.setId('note:2'),f=>f.setVersion(2),f=>f.lock()]){
  const f=await fixture();try{f.host.querySelector('img').click();change(f);f.doc.querySelector('[data-size=auto]').click();assert.equal(f.changes.length,0)}finally{f.close()}
 }
});
test('drag preview commits on release, cancellation preserves source and cleanup removes controls',async()=>{
 const f=await fixture();try{
  const image=f.host.querySelector('img');image.getBoundingClientRect=()=>({width:200,right:200,bottom:200}); image.click();
  const pointer=(type,x)=>{const event=new f.dom.window.MouseEvent(type,{clientX:x,bubbles:true,cancelable:true});Object.defineProperty(event,'pointerId',{value:1});f.doc.querySelector('.note-image-resize-handle').dispatchEvent(event)};
  pointer('pointerdown',200);pointer('pointermove',280);assert.equal(image.style.width,'280px');assert.equal(f.changes.length,0);
  pointer('pointercancel',280);assert.equal(image.style.width,'');assert.equal(f.changes.length,0);
  image.click();pointer('pointerdown',200);pointer('pointermove',320);pointer('pointerup',320);assert.match(f.source,/width="320"/);
 }finally{f.close()}
 assert.equal(f.doc.querySelector('.note-image-size-bar'),null);
});
test('HTML relative sources stay protected and retain dimensions; code examples remain literal',async()=>{
 const { rewriteRelativeImages }=await import('../public/js/knowledge/links-history.js');
 const source='<img src="./中文.png" width="320" alt="图">\n`<img src="./code.png">`\n~~~html\n<img src="./example.png">\n~~~';
 const result=rewriteRelativeImages(source,'note:12');
 assert.match(result,/<img src="\/api\/knowledge\/assets\/note%3A12\/%E4%B8%AD%E6%96%87.png" width="320" alt="图">/);
 assert(result.includes('`<img src="./code.png">`'));assert(result.includes('<img src="./example.png">'));
 assert.equal(rewriteRelativeImages('<img src="../secret.png">','note:12'),'<img src="../secret.png">');
});
test('illegal dimensions cannot enlarge preview beyond the note and invalid size keeps the source',async()=>{
 const { bindNoteImageSizing }=await load();const dom=new JSDOM('<div><img src="x.png" width="9999999" height="9999999" style="width:999999px;height:999999px;min-width:999999px;max-width:none"></div>');
 const host=dom.window.document.querySelector('div'),image=host.querySelector('img');let changes=0;
 const close=bindNoteImageSizing({host,getSource:()=>'<img src="x.png" width="9999999">',getDocumentId:()=>1,canEdit:()=>true,onChange:()=>changes++,openOriginal:()=>{}});
 assert.equal(image.getAttribute('width'),null);assert.equal(image.getAttribute('height'),null);assert.equal(image.style.height,'auto');assert.equal(image.style.maxWidth,'100%');assert.equal(image.style.minWidth,'0px');
 image.click();dom.window.document.querySelector('.note-image-size-bar input').value=-1;dom.window.document.querySelector('[data-size=pixels]').click();assert.equal(changes,0);assert.match(dom.window.document.querySelector('[role=status]').textContent,/16/);
 close();dom.window.close();
});
