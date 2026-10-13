// Dedicated, disposable acceptance instance. It never uses the user's normal DATA_DIR.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.join(os.tmpdir(),'liuxu-reader-demo-v1');const marker=path.join(root,'.reader-demo');
if(fs.existsSync(root)&&!fs.existsSync(marker))throw new Error('目标目录没有验收标识，拒绝修改');
if(process.argv.includes('--reset')&&fs.existsSync(marker))fs.rmSync(root,{recursive:true});
fs.mkdirSync(root,{recursive:true});fs.writeFileSync(marker,'LiuXu disposable reader acceptance data');
process.env.DATA_DIR=path.join(root,'data');process.env.LIUXU_KNOWLEDGE_ROOT=path.join(root,'knowledge');process.env.AI_SECRETS_KEY_FILE=path.join(root,'secrets');process.env.LIUXU_DESKTOP='0';
(async()=>{
 const {app,startServer}=require('../server');const server=await startServer(Number(process.env.READER_DEMO_PORT||3021),'127.0.0.1');const origin=`http://127.0.0.1:${server.address().port}`;
 const manifestFile=path.join(root,'manifest.json');let manifest;
 if(fs.existsSync(manifestFile))manifest=JSON.parse(fs.readFileSync(manifestFile));
 else {manifest=[];const {makeFixtures}=require('./reader-fixtures.cjs');for(const sample of await makeFixtures()) {const form=new FormData();form.set('file',new Blob([sample.buffer]),sample.name);form.set('knowledgeBase','阅读体验验收');form.set('title',sample.name);const response=await fetch(origin+'/api/knowledge/imports',{method:'POST',body:form});const result=await response.json();if(!response.ok)throw new Error(result.error);const doc=result.document||result;manifest.push({name:sample.name,id:doc.id,steps:sample.steps});}fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));}
 app.get('/reader-demo-manifest.json',(_req,res)=>res.json({samples:manifest,resetToken:fs.statSync(marker).mtimeMs}));
 console.log(`阅读验收页面：${origin}/reader-demo.html`); console.log('重置：停止实例后运行 npm run reader:demo:reset');
})().catch(error=>{console.error(error);process.exit(1);});
