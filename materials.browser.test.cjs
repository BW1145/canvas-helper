/* Independent browser fixtures; all course data and downloads are simulated. */
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {chromium} = require(require.resolve("playwright",{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()]}));
const origin = "https://canvas.example.invalid", assets = "https://assets.example.invalid";
const payloads = {1:Buffer.from("%PDF-1.7\nOriginal PDF bytes\n%%EOF"),2:Buffer.from([80,75,3,4,0,0,0,0,1,2,3]),3:Buffer.from([80,75,3,4,0,0,0,0,4,5,6]),4:Buffer.from("%PDF-1.7\nAnother file\n%%EOF")};
const names = {1:"Course outline.pdf",2:"Lecture 1.pptx",3:"Reading notes.docx",4:"Course outline.pdf",5:"Locked.pdf",6:"Retry.pdf"};
const item = (id,type,extra={}) => ({id:String(id),type,title:names[id] || "Reading materials",position:id,...extra});
(async()=>{
  const browser=await chromium.launch({headless:true,channel:process.env.CANVAS_HELPER_BROWSER_CHANNEL});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}), requests=[],errors=[];
  let metadataFailure=true,downloadFailure=true;
  page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(({source})=>{
    const file={name:"fixture-materials.zip",data:new Uint8Array()};
    window.fixture={file,pickers:0,permissions:[],exports:[]};
    let allowed=false;
    window.chrome={
      scripting:{async executeScript(request){if(request.files){window.eval(source);return [];}return [{result:await request.func(...request.args)}];}},
      permissions:{async contains(){return allowed;},async request(request){window.fixture.permissions.push(request);allowed=true;return true;}},
      downloads:{async download(request){window.fixture.exports.push(request);return 1;}}
    };
    window.showSaveFilePicker=async()=>{
      if(window.fixture.cancelPicker){window.fixture.cancelPicker=false;throw new DOMException("cancel","AbortError");}
      window.fixture.pickers++;
      return {name:file.name,async createWritable({keepExistingData}){
        let data=keepExistingData?file.data.slice():new Uint8Array(),pos=0;
        return {async write(chunk){const end=pos+chunk.length;if(data.length<end){const n=new Uint8Array(end);n.set(data);data=n;}data.set(chunk,pos);pos=end;},async seek(n){pos=n;},async truncate(n){data=data.slice(0,n);pos=Math.min(pos,n);},async close(){file.data=data.slice();},async abort(){}};
      }};
    };
    window.open=()=>{throw Error("Unexpected popup");};
  },{source:fs.readFileSync(path.join(__dirname,"materials-client.js"),"utf8")});
  await page.route("**/*",async route=>{
    const url=new URL(route.request().url());requests.push(url.href);
    if(url.origin===assets){
      const id=url.pathname.split("/").at(-1);
      if(id==="2"&&downloadFailure)return route.fulfill({status:503,body:"offline"});
      const body=payloads[id] || payloads[1];
      return route.fulfill({contentType:id==="1"||id==="4"?"application/pdf":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",headers:{"content-length":String(body.length)},body});
    }
    if(url.origin!==origin)return route.abort();
    if(url.pathname==="/api/v1/courses/12")return route.fulfill({json:{id:"12",name:"Composition Studio · 作曲工作室",course_code:"MUS 111"}});
    if(url.pathname==="/api/v1/courses/12/modules")return route.fulfill({json:url.searchParams.has("page")?[{id:"2",name:"Week 2 · Composition",position:2},{id:"3",name:"Week 3 · Development",position:3,state:"locked"}]:[{id:"1",name:"Week 1 · Introduction",position:1}],headers:url.searchParams.has("page")?{}:{link:'</api/v1/courses/12/modules?per_page=100&page=2>; rel="next"'}});
    if(url.pathname==="/api/v1/courses/12/modules/1/items")return route.fulfill({json:[item(1,"File",{content_id:"1"}),item(2,"File",{content_id:"2"}),item(8,"Page",{page_url:"readings"}),item(9,"ExternalUrl",{title:"YouTube lecture",external_url:"https://www.youtube.com/watch?v=demo&token=fixture-secret"})]});
    if(url.pathname==="/api/v1/courses/12/modules/2/items")return route.fulfill({json:[item(1,"File",{content_id:"1"}),item(4,"File",{content_id:"4"}),item(5,"File",{content_id:"5",content_details:{locked_for_user:true}}),item(6,"File",{content_id:"6"})]});
    if(url.pathname==="/api/v1/courses/12/pages/readings")return route.fulfill({json:{published:true,body:'<p><a href="/courses/12/files/1/download?verifier=private">Outline again</a><a href="/courses/12/files/3?wrap=1">Reading notes</a><a href="https://example.org/reading?auth=fixture-secret">Related reading</a></p><iframe src="https://www.youtube.com/embed/demo" title="Embedded video"></iframe><div hidden><a href="https://hidden.invalid">Hidden</a></div><script>window.open("https://unrelated.invalid")</script>'}});
    const meta=url.pathname.match(/^\/api\/v1\/courses\/12\/files\/(\d+)$/);
    if(meta){const id=meta[1];if(id==="6"&&metadataFailure)return route.fulfill({status:503,body:"offline"});return route.fulfill({json:{id,filename:names[id],size:(payloads[id]||payloads[1]).length,url:`${assets}/blob/${id}?signature=fixture-secret`,"content-type":"application/octet-stream"}});}
    const name=path.basename(url.pathname);
    if(!/^[\w.-]+\.(?:js|css|html)$/.test(name)||!fs.existsSync(path.join(__dirname,name)))return route.abort();
    return route.fulfill({contentType:name.endsWith("js")?"text/javascript":name.endsWith("css")?"text/css":"text/html",body:fs.readFileSync(path.join(__dirname,name))});
  });
  async function screenshot(name){if(process.env.CANVAS_HELPER_QA_DIR){fs.mkdirSync(process.env.CANVAS_HELPER_QA_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.CANVAS_HELPER_QA_DIR,name)});}}
  try{
    await page.goto(`${origin}/materials.html?sourceTab=42&course=12`);
    await page.waitForFunction(()=>document.getElementById("status").textContent.startsWith("已整理"));
    assert.equal(await page.locator(".chapter").count(),3);assert.equal(await page.locator(".file-row").count(),7);
    assert.equal(await page.locator("#linkCount").textContent(),"3 条");
    assert.equal(await page.locator('[data-focus="file-1:1"]').count(),1);
    assert.match(await page.locator(".file-row").first().textContent(),/Reading materials/);
    metadataFailure=false;await page.getByRole("button",{name:"重试读取",exact:true}).click();
    await page.waitForFunction(()=>document.getElementById("status").textContent==="文件信息已更新。");
    await page.locator("#typeFilter").selectOption("PDF");await page.locator("#selectAll").check();
    assert.equal(await page.locator("#selectedBtn").textContent(),"已选 4 个文件");
    assert.equal(await page.locator('[data-focus="file-2:5"]').isDisabled(),true);
    await page.locator("#typeFilter").selectOption("PPT");await page.locator("#selectAll").check();
    await page.locator("#selectedBtn").click();assert.equal(await page.locator(".file-row").count(),5);
    await page.locator("#selectedBtn").click();await page.locator("#typeFilter").selectOption("");
    await page.locator("#searchInput").fill("Reading notes");assert.equal(await page.locator(".file-row").count(),1);
    await page.locator("#selectAll").check();await page.locator("#searchInput").fill("");
    assert.equal(await page.locator("#selectedBtn").textContent(),"已选 6 个文件");
    await page.locator("#courseTitle").click();
    await screenshot("canvas-helper-materials.png");
    for(const width of [1920,1440,1024,768,540,390,320]){
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}: overflow`);
    }
    await page.setViewportSize({width:390,height:844});await screenshot("canvas-helper-materials-mobile.png");
    await page.locator("#linksToggle").click();assert.equal(await page.locator(".external-item").count(),3);
    assert.doesNotMatch(await page.locator("#externalList").textContent(),/fixture-secret|Hidden/);
    assert.equal(requests.some(u=>/youtube|example\.org|hidden\.invalid|unrelated\.invalid/.test(u)),false);
    await page.locator("#exportLinksBtn").click();assert.equal(await page.evaluate(()=>fixture.exports.length),1);
    await page.setViewportSize({width:1440,height:1000});
    await page.locator("#downloadBtn").click();await page.waitForFunction(()=>document.getElementById("status").textContent.startsWith("下载站点已授权"));
    assert.equal(await page.evaluate(()=>fixture.pickers),0);
    assert.deepEqual(await page.evaluate(()=>fixture.permissions[0].origins),[`${assets}/*`]);
    const beforeCancelled=requests.filter(u=>u.startsWith(assets)).length;
    await page.evaluate(()=>{fixture.cancelPicker=true;});
    await page.locator("#downloadBtn").click();
    await page.waitForFunction(()=>document.getElementById("status").textContent==="已取消保存位置选择。");
    assert.equal(requests.filter(u=>u.startsWith(assets)).length,beforeCancelled);
    await page.locator("#downloadBtn").click();await page.waitForFunction(()=>document.getElementById("archiveStatus").textContent.startsWith("fixture-materials.zip 已保存"));
    assert.match(await page.locator("#archiveStatus").textContent(),/5 \/ 6.*1 个失败/);
    const before=requests.filter(u=>u.startsWith(assets)).length;downloadFailure=false;
    await page.locator("#retryBtn").click();await page.waitForFunction(()=>document.getElementById("archiveStatus").textContent.includes("6 / 6"));
    assert.equal(await page.evaluate(()=>fixture.pickers),1);assert.equal(requests.filter(u=>u.startsWith(assets)).length,before+1);
    const data=Buffer.from(await page.evaluate(()=>Array.from(fixture.file.data))),view=new DataView(data.buffer,data.byteOffset,data.length);
    const zipEnd=Number(view.getBigUint64(data.length-42+8,true));assert.equal(view.getUint32(zipEnd,true),0x06064b50);
    assert.equal(Number(view.getBigUint64(zipEnd+32,true)),8,"six files + one CSV + one link page");
    assert.deepEqual(errors,[]);
    console.log("materials browser: paginated modules, page attachments, selection/filtering, metadata retry, ZIP retry, permission flow, external-list export and 7 viewport widths passed");
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
