const JSZip = require('jszip');
const zlib = require('node:zlib');
const paragraph = '清晨的光穿过书页，我们把今天观察到的细节记录下来。知识的生长不只来自阅读，也来自提问、实践与回顾。每一条记录都连接着新的线索，让下一次重读有不同的发现。 Reading brings new connections and patient growth.';
function pixels(w,h,page=0) {
 const data=Buffer.alloc(w*h*3,246); for(let y=0;y<h;y++) for(let x=0;x<w;x++) {const i=(y*w+x)*3; let c=y<h*.28?[208-page*8,222,213]:[248,246,238]; if(y>h*.38 && y<h*.85 && (y%24)<4 && x>w*.12 && x<w*(.88-(Math.floor(y/24)%3)*.08)) c=[76,83,78]; if(y>h*.15 && y<h*.21 && x>w*.12 && x<w*.75) c=[48,67,55]; data.set(c,i);} return data;
}
function crc(buf) { let c=0xffffffff; for(const b of buf) {c^=b;for(let j=0;j<8;j++) c=(c>>>1)^((c&1)?0xedb88320:0);} return (c^0xffffffff)>>>0; }
function png(w=360,h=480,page=0) { const chunk=(type,data)=> {const t=Buffer.from(type),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([head,t,data,tail]);}; const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;const raw=pixels(w,h,page),lines=[];for(let y=0;y<h;y++)lines.push(Buffer.from([0]),raw.subarray(y*w*3,(y+1)*w*3));return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.concat(lines))),chunk('IEND',Buffer.alloc(0))]); }
async function epub({images=false,fixed=false}={}) {
 const zip=new JSZip();zip.file('mimetype','application/epub+zip',{compression:'STORE'});zip.file('META-INF/container.xml','<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
 const n=fixed?3:5;const names=Array.from({length:n},(_,i)=>`chapter${i+1}`);
 zip.file('book.opf',`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">liuxu-original-${images}-${fixed}</dc:identifier><dc:title>让知识有序生长</dc:title><dc:language>zh</dc:language>${fixed?'<meta property="rendition:layout">pre-paginated</meta>':''}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="picture" href="illustration.png" media-type="image/png"/>${names.map(x=>`<item id="${x}" href="${x}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${names.map(x=>`<itemref idref="${x}"/>`).join('')}</spine></package>`);
 zip.file('nav.xhtml',`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${names.map((x,i)=>`<li><a href="${x}.xhtml">第${i+1}章 · ${['观察','阅读','连接','回顾','生长'][i]}</a></li>`).join('')}</ol></nav></body></html>`);
 zip.file('illustration.png',png());
 for(const [i,x] of names.entries())zip.file(`${x}.xhtml`,`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>第${i+1}章</title>${fixed?'<meta name="viewport" content="width=600,height=800"/>':''}<style>body{padding:1em} h1{font-size:1.5em} p{margin:.8em 0} img{max-width:100%;max-height:320px} table{border-collapse:collapse;width:100%} td,th{border:1px solid #aaa;padding:.5em}</style></head><body><h1>第${i+1}章 · 让知识有序生长</h1>${images||fixed?'<img src="illustration.png" alt="原创书页插图"/>':''}${Array.from({length:fixed?2:images?14:45},(_,j)=>`<p>${j+1}. ${paragraph}</p>`).join('')}<h2>实践清单</h2><ul><li>记录一个观察</li><li>提出一个问题</li><li>连接一条旧笔记</li></ul><blockquote>持续阅读，让理解慢慢生长。</blockquote>${images?'<table><tr><th>阶段</th><th>目标</th></tr><tr><td>阅读</td><td>寻找线索</td></tr><tr><td>回顾</td><td>形成连接</td></tr></table><p>阅读说明<a epub:type="noteref" href="#footnote">[1]</a></p><aside id="footnote" epub:type="footnote"><p>这是书内脚注，内容不依赖外部资源。</p></aside>':''}</body></html>`);
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
function mobi() {
 let html='<html><head><guide><reference type="toc" title="目录" filepos="0000000000"/></guide></head><body><h1>知识生长日记</h1><div id="toc"><a filepos="1111111111">第一章 · 观察</a><br/><a filepos="2222222222">第二章 · 连接</a></div><mbp:pagebreak/><h1 id="one">第一章 · 观察</h1>'+`<p>${paragraph}</p>`.repeat(24)+'<mbp:pagebreak/><h1 id="two">第二章 · 连接</h1>'+`<p>${paragraph}</p>`.repeat(24)+'</body></html>';
 const offset=needle=>String(Buffer.byteLength(html.slice(0,html.indexOf(needle)))).padStart(10,'0');
 const toc=offset('<div id="toc">'),one=offset('<h1 id="one">'),two=offset('<h1 id="two">');html=html.replace('0000000000',toc).replace('1111111111',one).replace('2222222222',two);
 const text=Buffer.from(html),records=[];for(let i=0;i<text.length;i+=4096)records.push(text.subarray(i,i+4096));const title=Buffer.from('知识生长日记');const header=Buffer.alloc(248+title.length);header.writeUInt16BE(1);header.writeUInt32BE(text.length,4);header.writeUInt16BE(records.length,8);header.writeUInt16BE(4096,10);header.write('MOBI',16);header.writeUInt32BE(232,20);header.writeUInt32BE(2,24);header.writeUInt32BE(65001,28);header.writeUInt32BE(12345,32);header.writeUInt32BE(6,36);header.writeUInt32BE(248,84);header.writeUInt32BE(title.length,88);header[95]=4;header.writeUInt32BE(records.length+1,108);header.writeUInt32BE(0xffffffff,244);title.copy(header,248);records.unshift(header);
 const pdb=Buffer.alloc(78+records.length*8+2);pdb.write('LiuXu original reading sample');pdb.write('BOOKMOBI',60);pdb.writeUInt16BE(records.length,76);let start=pdb.length;records.forEach((r,i)=>{pdb.writeUInt32BE(start,78+i*8);pdb[78+i*8+7]=i;start+=r.length;});return Buffer.concat([pdb,...records]);
}
function pdf({scan=false}={}) {
 const objects=[null,null];const add=x=>(objects.push(Buffer.isBuffer(x)?x:Buffer.from(x)),objects.length);
 const stream=(data,extra='')=>Buffer.concat([Buffer.from(`<< /Length ${data.length} ${extra} >>\nstream\n`),data,Buffer.from('\nendstream')]);
 const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');const pages=[];
 for(let i=0;i<8;i++){ const landscape=i===3,w=landscape?792:612,h=landscape?612:792;let resources=`/Font << /F1 ${font} 0 R >>`,body;
 if(scan){const image=add(stream(zlib.deflateSync(pixels(360,480,i)), '/Type /XObject /Subtype /Image /Width 360 /Height 480 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode'));resources=`/XObject << /Im1 ${image} 0 R >>`;body=Buffer.from(`q ${w-72} 0 0 ${h-72} 36 36 cm /Im1 Do Q`);}
 else body=Buffer.from(`BT /F1 24 Tf 48 ${h-64} Td (Chapter ${i+1}: Patient growth) Tj /F1 12 Tf 0 -40 Td `+Array.from({length:Math.floor((h-140)/23)},(_,j)=>`(Line ${j+1}: Reading connects observation, practice and growth.) Tj 0 -23 Td`).join(' ')+' ET');
 const contents=add(stream(body));pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << ${resources} >> /Contents ${contents} 0 R >>`)); }
 const outline=add('');const entries=pages.map((page,i)=>add(''));entries.forEach((id,i)=>objects[id-1]=Buffer.from(`<< /Title (Chapter ${i+1}: Growth) /Parent ${outline} 0 R /Dest [${pages[i]} 0 R /Fit] ${i?`/Prev ${entries[i-1]} 0 R`:''} ${i<entries.length-1?`/Next ${entries[i+1]} 0 R`:''} >>`));objects[outline-1]=Buffer.from(`<< /Type /Outlines /First ${entries[0]} 0 R /Last ${entries.at(-1)} 0 R /Count ${entries.length} >>`);objects[0]=Buffer.from(`<< /Type /Catalog /Pages 2 0 R /Outlines ${outline} 0 R >>`);objects[1]=Buffer.from(`<< /Type /Pages /Kids [${pages.map(id=>`${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
 const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let size=chunks[0].length;objects.forEach((obj,i)=>{offsets.push(size);const c=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);chunks.push(c);size+=c.length;});chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(x=>`${String(x).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`));return Buffer.concat(chunks);
}
async function makeFixtures(){const comic=new JSZip();for(let i=0;i<5;i++)comic.file(`page${i+1}.png`,png(360,480,i));return [
 {name:'长篇阅读.epub',buffer:await epub(),steps:'翻页、宽屏双栏；目录跳转；调整字号后续读；搜索“生长”并摘录。'},
 {name:'图文阅读.epub',buffer:await epub({images:true}),steps:'插图、表格、列表与脚注；窄屏单栏；浅色／暖色／深色主题。'},
 {name:'知识生长日记.mobi',buffer:mobi(),steps:'真正的 MOBI6 无 DRM 文件；中文目录、分页、搜索与摘录。'},
 {name:'文字与横向页面.pdf',buffer:pdf(),steps:'左侧缩略图与当前页同步；第 4 页为横向；搜索 growth；缩放后摘录定位。'},
 {name:'扫描页面.pdf',buffer:pdf({scan:true}),steps:'图片扫描页无可选文字；缩略图、缩放及页码书签可用。'},
 {name:'章节小说.txt',buffer:Buffer.from('第一章 观察\n'+(paragraph+'\n').repeat(70)+'第二章 连接\n'+(paragraph+'\n').repeat(70)),steps:'章节识别、阅读／原文切换、分页与重开续读。'},
 {name:'原创图册.cbz',buffer:await comic.generateAsync({type:'nodebuffer'}),steps:'图片分页、单双页、方向切换；不显示文字摘录。'},
 {name:'固定版式.epub',buffer:await epub({fixed:true}),steps:'保留固定页面比例；单双页与缩放；不提供重排字号。'},
 {name:'损坏文件.epub',buffer:Buffer.from('not an EPUB'),steps:'显示明确失败和重试／下载入口；随后打开正常文件不受影响。'}
 ];}
module.exports={makeFixtures,epub,mobi,pdf,png};
