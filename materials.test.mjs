import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {fileKind,selectRows,matching,readChapter,archiveRows,archiveLinks,MaterialsArchive,externalHtml,checklist} from "./materials-model.js";
import {fetchMaterialStream,downloadOrigins} from "./materials-transfer.js";
const bytes = value => new TextEncoder().encode(value);
const origin = "https://canvas.example.invalid";
const row = (id,name = "资料.pdf",extra = {}) => ({key:`1:${id}`,id:String(id),moduleId:"1",chapter:"第一章",name,kind:fileKind(name),size:12,url:`${origin}/files/${id}/download?verifier=secret`,sources:[{title:"课程页面",url:`${origin}/courses/12/pages/start`}],...extra});
function clientHarness(route) {
  const calls = [], context = {URL,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout,location:new URL(origin + "/"),async fetch(url,options) {
    calls.push({url:new URL(url),options}); assert.equal(options.method,"GET"); assert.equal(options.credentials,"include"); assert.equal(options.redirect,"manual");
    const result = route(new URL(url)); return Response.json(result.data,{status:result.status || 200,headers:result.headers});
  }};
  vm.runInNewContext(readFileSync(new URL("./materials-client.js",import.meta.url),"utf8"),context);
  return {client:context.CanvasMaterialsClient,calls};
}
const catalogRoute = url => url.pathname.endsWith("/modules") ? {data:[{id:"1",name:"First",position:1},{id:"2",name:"Second",position:2,state:"locked"}]} : {data:{id:"12",name:"Composition",course_code:"MUS111"}};
test("materials API follows module/item pagination and preserves string IDs",async () => {
  const h = clientHarness(url => {
    if (url.pathname.endsWith("/modules") && !url.searchParams.has("page")) return {data:[{id:"9007199254740993",name:"First",position:1}],headers:{link:`<${origin}/api/v1/courses/12/modules?per_page=100&page=2>; rel="next"`}};
    if (url.pathname.endsWith("/modules")) return {data:[{id:"2",name:"Second",position:2}]};
    if (url.pathname.endsWith("/items") && !url.searchParams.has("page")) return {data:[{id:"4",type:"File",content_id:"10",title:"A.pdf"}],headers:{link:'</api/v1/courses/12/modules/9007199254740993/items?include%5B%5D=content_details&per_page=100&page=2>; rel="next"'}};
    if (url.pathname.endsWith("/items")) return {data:[{id:"5",type:"File",content_id:"11",title:"B.docx"}]};
    return catalogRoute(url);
  });
  const catalog = await h.client.catalog("12"); assert.equal(catalog.modules[0].id,"9007199254740993");
  const items = await h.client.moduleItems("12",catalog.modules[0].id); assert.equal(items.items.length,2); assert.equal(items.items[1].id,"11");
  assert.equal(h.calls.length,5);
});
test("materials API rejects foreign pagination, invalid file IDs and unlisted modules",async () => {
  const h = clientHarness(url => url.pathname.endsWith("/modules") ? {data:[],headers:{link:'<https://outside.invalid/secret>; rel="next"'}} : catalogRoute(url));
  assert.equal((await h.client.catalog("12")).code,"BAD_PAGINATION");
  const clean = clientHarness(catalogRoute); await clean.client.catalog("12"); const count = clean.calls.length;
  assert.equal((await clean.client.file("12","../999")).code,"INVALID_ID");
  assert.equal((await clean.client.moduleItems("12","999")).code,"BAD_TARGET");
  assert.equal(clean.calls.length,count);
  assert.equal((await clean.client.catalog(9007199254740992)).code,"INVALID_ID");
});
test("materials API preserves visible references and current per-user file lock state",async () => {
  const h = clientHarness(url => {
    if (url.pathname.endsWith("/items")) return {data:[{id:"3",type:"File",content_id:"10",title:"A.pdf"},{id:"4",type:"File",content_id:"11",title:"Locked.pdf",content_details:{locked_for_user:true}},{id:"5",type:"ExternalUrl",title:"Video",external_url:"https://youtube.com/watch?v=abc&token=secret"},{id:"6",type:"ExternalUrl",title:"Attachment",external_url:`${origin}/courses/12/files/10/download`}]};
    if (url.pathname.endsWith("/files/10")) return {data:{id:"10",filename:"A.pdf",size:12,locked:true,locked_for_user:false,url:`${origin}/files/10/download`}};
    if (url.pathname.endsWith("/files/11")) return {data:{id:"11",filename:"Locked.pdf",locked_for_user:true}};
    return catalogRoute(url);
  });
  await h.client.catalog("12"); const result = await h.client.moduleItems("12","1");
  assert.equal(result.items[1].locked,true); assert.equal((await h.client.file("12","11")).locked,true);
  assert.equal((await h.client.file("12","10")).locked,false);
  assert.equal(result.items[2].url,"https://youtube.com/watch?v=abc");
  assert.equal(result.items[3].kind,"file"); assert.equal(result.items[3].id,"10");
});
test("materials authentication and rate responses remain explicit",async () => {
  for (const [status,code] of [[401,"AUTH_REQUIRED"],[403,"ACCESS_DENIED"],[429,"RATE_LIMIT"]]) {
    const h = clientHarness(() => ({data:{},status})); assert.equal((await h.client.catalog("12")).code,code);
  }
});
test("file metadata remains downloadable after the Canvas document context is replaced",async () => {
  const h = clientHarness(url => {
    assert.equal(url.pathname,"/api/v1/courses/12/files/10");
    return {data:{id:"10",filename:"A.pdf",size:12,url:`${origin}/files/10/download`}};
  });
  const file=await h.client.file("12","10");
  assert.equal(file.ok,true);assert.equal(file.name,"A.pdf");assert.equal(h.calls.length,1);
  const denied=clientHarness(()=>({status:403,data:{}}));
  assert.equal((await denied.client.file("12","10")).code,"ACCESS_DENIED");
});
test("chapter scans merge repeated files, preserve page sources and only list external URLs",async () => {
  const calls = [];
  const call = async (method,args) => {calls.push([method,...args]);
    if (method === "moduleItems") return {items:[{kind:"file",id:"10",title:"A.pdf",source:"direct"},{kind:"page",page:"start",title:"Readings",source:"page"},{kind:"external",url:"https://youtube.com/watch?v=x",title:"Video",source:"video"}]};
    if (method === "pageLinks") return {refs:[{kind:"file",id:"10",title:"A"},{kind:"file",id:"11",title:"Notes.docx"},{kind:"external",url:"https://example.org/",title:"Website"}]};
    return {name:args[1] === "10" ? "A.pdf" : "Notes.docx",size:12,url:"https://files.example.invalid/a",locked:false};
  };
  const chapter = await readChapter({id:"1",name:"Week 1"},"12",call,new AbortController().signal);
  assert.equal(chapter.rows.length,2); assert.equal(chapter.rows[0].sources.length,2); assert.equal(chapter.links.length,2);
  assert.deepEqual(calls.filter(c => c[0] === "file").map(c => c[2]),["10","11"]);
});
test("failed pages and file metadata leave retryable rows and chapter issues",async () => {
  const chapter = await readChapter({id:"1",name:"First"},"12",async method => {
    if (method === "moduleItems") return {items:[{kind:"file",id:"10",title:"A.pdf",source:"x"},{kind:"page",page:"a",title:"Reading",source:"p"}]};
    throw new Error("读取失败");
  },new AbortController().signal);
  assert.equal(chapter.rows[0].error,"读取失败"); assert.equal(chapter.issues.length,1);
  const lock = await readChapter({id:"2",locked:true},"12",() => assert.fail("locked module must not be read")); assert.equal(lock.rows.length,0);
});
test("chapter progress publishes selectable files before later metadata completes",async () => {
  let release,firstReady;
  const first=new Promise(resolve=>{firstReady=resolve;});
  const task=readChapter({id:"1",name:"Week 1"},"12",async(method,args)=>{
    if(method==="moduleItems")return {items:[{kind:"file",id:"10",title:"First.pdf",source:"first"},{kind:"file",id:"11",title:"Later.pdf",source:"later"}]};
    if(args[1]==="11")await new Promise(resolve=>{release=resolve;});
    return {name:args[1]+".pdf",size:12,url:origin+"/files/"+args[1]+"/download",locked:false};
  },new AbortController().signal,new Map(),partial=>{if(partial.rows.length===1)firstReady(partial);});
  const partial=await first;assert.equal(partial.ready,false);assert.equal(partial.rows.length,1);
  const selected=new Set();selectRows(selected,partial.rows,true);assert.equal(selected.size,1);
  const snapshot=archiveRows([partial],selected);partial.rows[0].sources.push({title:"Later source",url:"later"});
  assert.equal(snapshot[0].sources.length,1);
  await new Promise(resolve=>setImmediate(resolve));release();
  const complete=await task;assert.equal(complete.rows.length,2);assert.equal(snapshot.length,1);
});
test("visible selection excludes locked/error files and search includes chapter and page names",() => {
  const rows = [row(1),row(2,"Notes.docx"),row(3,"Locked.pdf",{locked:true}),row(4,"Error.pdf",{error:"failed"})], selected = new Set();
  const filtered = rows.filter(r => matching({name:"第一章"},r,"第一章","PDF")); selectRows(selected,filtered,true);
  assert.deepEqual([...selected],["1:1"]); selectRows(selected,[rows[1]],true); assert.equal(selected.size,2);
  selectRows(selected,filtered,false); assert.deepEqual([...selected],["1:2"]);
  assert.equal(matching({name:"First"},rows[0],"课程页面",""),true);
});
test("archive paths retain chapter order and safely disambiguate names",() => {
  const chapters = [{id:"1",name:"../Week 1",rows:[row(1,"../Notes.pdf"),row(2,"../Notes.pdf")]},{id:"2",name:"Week 2",rows:[row(1,"Notes.pdf",{key:"2:1"})]}];
  const plan = archiveRows(chapters,new Set(["1:1","1:2","2:1"]));
  assert.equal(plan.length,3); assert.notEqual(plan[0].filename,plan[1].filename); assert.match(plan[1].filename,/\(2\)\.pdf$/);
  assert.ok(plan.every(r => !r.filename.split("/").includes(".."))); assert.match(plan[2].filename,/^02 /);
});
test("ZIP link attachments include only chapters represented by selected files",() => {
  const first={moduleId:"1",url:"https://example.org/first"},second={moduleId:"2",url:"https://example.org/second"};
  const chapters=[{id:"1",links:[first]},{id:"2",links:[second]}];
  assert.deepEqual(archiveLinks(chapters,[row(2,"Notes.pdf",{moduleId:"2"})]),[second]);
  assert.deepEqual(archiveLinks(chapters,[]),[]);
});
test("exports keep useful links while escaping HTML and excluding signed download URLs",() => {
  const html = externalHtml({name:'<script>alert(1)</script>'},[{title:'<img onerror="x">',url:"https://youtube.com/watch?v=abc&token=secret",source:"https://canvas.example.invalid/courses/12/pages/x",sourceTitle:"Page",moduleId:"1",chapter:"Week 1"}]);
  assert.doesNotMatch(html,/<script>|<img|secret/); assert.match(html,/watch\?v=abc/);
  const csv = checklist([{...row(1,"=SUM(1).pdf"),status:"success",filename:"01/Notes.pdf"}]);
  assert.match(csv,/'=SUM/); assert.doesNotMatch(csv,/verifier|secret/);
});
class Handle {
  name = "materials.zip"; data = new Uint8Array(); failClose = false;
  async createWritable({keepExistingData}) {
    const handle = this; let data = keepExistingData ? handle.data.slice() : new Uint8Array(), position = 0;
    return {
      async write(chunk) {const end = position + chunk.length; if (data.length < end) {const next = new Uint8Array(end); next.set(data); data = next;} data.set(chunk,position); position = end;},
      async seek(n) {position = n;}, async truncate(n) {data = data.slice(0,n); position = Math.min(position,n);},
      async close() {if (handle.failClose) throw new Error("disk failure"); handle.data = data.slice();}, async abort() {}
    };
  }
}
function entries(data) {
  const view = new DataView(data.buffer,data.byteOffset,data.length), loc = data.length-42, end = Number(view.getBigUint64(loc+8,true));
  const count = Number(view.getBigUint64(end+32,true)); let pos = Number(view.getBigUint64(end+48,true)); const files = new Map();
  for(let i=0;i<count;i++) {
    assert.equal(view.getUint32(pos,true),0x02014b50); const n=view.getUint16(pos+28,true),ex=pos+46+n;
    const name=new TextDecoder().decode(data.subarray(pos+46,pos+46+n)),size=Number(view.getBigUint64(ex+4,true)),local=Number(view.getBigUint64(ex+20,true));
    const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true),body=data.slice(start,start+size);
    let crc=0xffffffff; for(const b of body) {crc^=b; for(let bit=0;bit<8;bit++) crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}
    assert.equal((crc^0xffffffff)>>>0,view.getUint32(pos+16,true)); files.set(name,body); pos+=46+n+view.getUint16(pos+30,true)+view.getUint16(pos+32,true);
  }
  return files;
}
test("archive retry preserves completed files and replaces the single CSV/link tail",async () => {
  const handle = new Handle(), plan = archiveRows([{id:"1",name:"Week 1",rows:[row(1),row(2,"Notes.docx")]}],new Set(["1:1","1:2"]));
  const archive = new MaterialsArchive(handle,{name:"Composition"},plan,[],true); let failed = true; const fetched=[];
  const options = {getFile:async id => ({...row(id,id === "1" ? "资料.pdf" : "Notes.docx"),locked:false}),fetchFile:async file => {fetched.push(file.id); if(file.id === "2" && failed) throw new Error("offline"); return bytes("ORIGINAL "+file.id);}};
  await archive.run(options); assert.equal(archive.saved,true); assert.equal(archive.rows[1].status,"error");
  const first = entries(handle.data); assert.equal(first.size,3);
  failed=false; await archive.run(options); const final=entries(handle.data);
  assert.deepEqual(fetched,["1","2","2"]); assert.equal(final.size,4);
  assert.deepEqual(final.get(plan[0].filename),bytes("ORIGINAL 1")); assert.deepEqual(final.get(plan[1].filename),bytes("ORIGINAL 2"));
  assert.equal([...final.keys()].filter(n=>n==="资料清单.csv").length,1);
});
test("stop saves a valid partial archive and a second run continues unfinished files",async () => {
  const handle=new Handle(),ctrl=new AbortController(),plan=archiveRows([{id:"1",name:"Week 1",rows:[row(1),row(2)]}],new Set(["1:1","1:2"]));
  const archive=new MaterialsArchive(handle,{name:"Course"},plan,[],false);
  const options={getFile:async id=>row(id),fetchFile:async()=>bytes("PDF bytes"),onUpdate(r){if(r?.id==="1"&&r.status==="success") ctrl.abort();},signal:ctrl.signal};
  await archive.run(options); assert.equal(entries(handle.data).size,2); assert.equal(archive.rows[1].status,"pending");
  await archive.run({...options,signal:new AbortController().signal,onUpdate(){}}); assert.equal(entries(handle.data).size,3);
});
test("failed disk commits restore pending work and retain the last saved archive",async () => {
  const handle=new Handle(),plan=archiveRows([{id:"1",name:"First",rows:[row(1)]}],new Set(["1:1"]));
  const archive=new MaterialsArchive(handle,{name:"Course"},plan,[],true),options={getFile:async()=>row(1),fetchFile:async()=>bytes("original")};
  handle.failClose=true; await assert.rejects(archive.run(options)); assert.equal(handle.data.length,0); assert.equal(archive.rows[0].status,"pending");
  handle.failClose=false; await archive.run(options); assert.equal(entries(handle.data).size,3);
});
const consume=async stream=>{const chunks=[];for await(const c of stream)chunks.push(c);return Buffer.concat(chunks.map(c=>Buffer.from(c)));};
test("transfer validates PDF, modern Office and legacy Office bytes without altering content",async () => {
  const previous=globalThis.fetch;
  try {for(const [name,data,type] of [["a.pdf",bytes("%PDF-1.7\noriginal"),"application/pdf"],["b.docx",Uint8Array.from([80,75,3,4,0,0,0,0,1]),"application/vnd.openxmlformats-officedocument.wordprocessingml.document"],["c.ppt",Uint8Array.from([208,207,17,224,161,177,26,225,1]),"application/vnd.ms-powerpoint"]]) {
    globalThis.fetch=async()=>new Response(data,{headers:{"content-type":type,"content-length":String(data.length)}});
    assert.deepEqual(await consume(await fetchMaterialStream({url:`${origin}/file`,name,size:data.length})),Buffer.from(data));
  }} finally {globalThis.fetch=previous;}
});
test("transfer rejects login HTML, partial files and truncated responses",async () => {
  const previous=globalThis.fetch;
  try {for(const response of [new Response("login",{headers:{"content-type":"text/html"}}),new Response(bytes("%PDF-1.7xxx"),{status:206}),new Response(bytes("%PDF-1.7xxx"),{headers:{"content-type":"application/pdf"}}),new Response(bytes("<html>login</html>"),{headers:{"content-type":"application/octet-stream"}})]) {
    globalThis.fetch=async()=>response;
    await assert.rejects(async()=>consume(await fetchMaterialStream({url:`${origin}/file`,name:"a.pdf",size:999})));
  }} finally {globalThis.fetch=previous;}
});
test("download origins are limited to actual file addresses and redirect permission hints",() => {
  assert.deepEqual(downloadOrigins([{url:"https://files.example.invalid/a?signature=private"},{url:"javascript:alert(1)"},{permissionOrigin:"https://cdn.example.invalid/*"}]),["https://files.example.invalid/*","https://cdn.example.invalid/*"]);
});
test("stopping during a blocked file body rolls back that file and saves the completed prefix",async () => {
  const handle=new Handle(),ctrl=new AbortController(),plan=archiveRows([{id:"1",name:"First",rows:[row(1),row(2)]}],new Set(["1:1","1:2"]));
  const archive=new MaterialsArchive(handle,{name:"Course"},plan,[],false);
  let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const task=archive.run({signal:ctrl.signal,getFile:async id=>row(id),fetchFile:async file=>file.id==="1"?bytes("FIRST COMPLETE"):(async function*(){yield bytes("PARTIAL");started();await new Promise((resolve,reject)=>ctrl.signal.addEventListener("abort",()=>reject(new DOMException("stop","AbortError")),{once:true}));})()});
  await ready;ctrl.abort();await task;
  const files=entries(handle.data);assert.equal(files.size,2);assert.deepEqual(files.get(plan[0].filename),bytes("FIRST COMPLETE"));assert.equal(files.has(plan[1].filename),false);
  assert.equal(archive.rows[1].status,"pending");
});
test("transfer header timeouts and actual redirected permission hints remain retryable",async () => {
  const previous=globalThis.fetch,previousChrome=globalThis.chrome;
  try{
    globalThis.fetch=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(new DOMException("timeout","AbortError")),{once:true}));
    await assert.rejects(fetchMaterialStream({url:`${origin}/file`,name:"a.pdf"},{timeout:5}),e=>e.code==="TIMEOUT");
    let observer;
    globalThis.chrome={runtime:{getURL:()=>"chrome-extension://fixture/"},tabs:{getCurrent:async()=>({id:42})},webRequest:{onBeforeRedirect:{addListener(fn){observer=fn;},removeListener(fn){assert.equal(fn,observer);}}},permissions:{contains:async()=>false}};
    globalThis.fetch=async()=>{observer({initiator:"chrome-extension://fixture",tabId:42,type:"xmlhttprequest",requestId:"r1",url:`${origin}/file`,redirectUrl:"https://cdn.example.invalid/blob?signature=private"});throw new TypeError("blocked");};
    await assert.rejects(fetchMaterialStream({url:`${origin}/file`,name:"a.pdf"}),e=>e.code==="HOST_PERMISSION"&&e.permissionOrigin==="https://cdn.example.invalid/*"&&!e.message.includes("private"));
  }finally{globalThis.fetch=previous;globalThis.chrome=previousChrome;}
});
