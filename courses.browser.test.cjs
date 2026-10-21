/* Optional browser fixtures: Playwright + Chromium. All requests use local fixtures. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require(require.resolve("playwright", {paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()]}));
const origin = "https://canvas.example.invalid";
const folder = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const video = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const panopto = "https://school.panopto.com";
const original = "课程完整介绍：这一段文字应完整显示，包括课程目标与作业安排。".repeat(30);
const raw = id => ({id: String(id), name: `Course ${id}`, course_code: `MUSIC ${id}`, workflow_state: "available", default_view: "wiki",
  term: {id: id === 9 ? "20251" : "20262", name: id === 9 ? "2025 Academic Year Term" : "2026 Semester Two", start_at: "2025-01-01", end_at: "2027-01-01"}});

(async () => {
  const browser = await chromium.launch({headless: true, channel: process.env.CANVAS_HELPER_BROWSER_CHANNEL});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const popups = [], errors = [], requests = [];
  page.on("popup", popup => popups.push(popup));
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({client}) => {
    Date.now = () => Date.parse("2026-10-21T06:00:00Z");
    window.chrome = {scripting: {async executeScript(request) {
      if (request.files) {window.eval(client); return [];}
      return [{result: await request.func(...request.args)}];
    }}, tabs: new Proxy({}, {get() {throw Error("Unexpected tab operation");}})};
    window.open = () => {throw Error("Unexpected popup");};
  }, {client: fs.readFileSync(path.join(__dirname, "canvas-client.js"), "utf8")});
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()); requests.push(url.href);
    if (url.origin === panopto && url.pathname === `/Panopto/api/v1/folders/${folder}/sessions`) {
      return route.fulfill({json: {Results: [{Id: video, Folder: folder, Status: "Complete"}]}});
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/api/v1/courses") return route.fulfill({json: (url.searchParams.get("enrollment_state") === "active" ? [1, 2, 3] : [1, 2, 3, 9]).map(raw)});
    const front = url.pathname.match(/^\/api\/v1\/courses\/(\d+)\/front_page$/);
    if (front) return route.fulfill({json: {published: true, body: `<p>${front[1] === "1" ? original : "Teacher course introduction"}</p>`, url: "welcome"}});
    const tabs = url.pathname.match(/^\/api\/v1\/courses\/(\d+)\/tabs$/);
    if (tabs) return route.fulfill({json: [{label: "Panopto Video", html_url: tabs[1] === "1"
      ? `${panopto}/Panopto/Pages/EmbeddedList.aspx?folderID=${folder}` : `${origin}/courses/${tabs[1]}/external_tools/42`}]});
    const tool = url.pathname.match(/^\/courses\/(\d+)\/external_tools\/42$/);
    if (tool) return route.fulfill({contentType: "text/html", body: tool[1] === "2"
      ? `<script>window.open('https://unrelated.invalid')</script><iframe src="${panopto}/Panopto/Pages/EmbeddedList.aspx?folderID=${folder}"></iframe>`
      : `<form method="post" action="${panopto}/Panopto/LTI/LTI.aspx"><input name="oauth_signature" value="fixture-secret"></form>`});
    const name = path.basename(url.pathname);
    if (!/^[\w.-]+\.(?:html|css|js)$/.test(name) || !fs.existsSync(path.join(__dirname, name))) return route.abort();
    return route.fulfill({contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: fs.readFileSync(path.join(__dirname, name))});
  });
  try {
    await page.goto(`${origin}/courses.html?sourceTab=42`);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("已整理"));
    assert.equal(await page.locator(".course-card").count(), 3);
    assert.equal(await page.locator(".course-description").first().textContent(), original);
    assert.equal(await page.locator(".course-description").first().evaluate(node => node.scrollHeight <= node.clientHeight + 1), true);
    assert.deepEqual(await page.locator(".video-badge").allTextContents(), ["Panopto · 有视频", "Panopto · 有视频", "Panopto · 已找到入口"]);
    assert.equal(requests.some(url => /courses\/9\//.test(url)), false);
    assert.equal(requests.some(url => /LTI\.aspx|unrelated\.invalid/.test(url)), false);
    assert.equal(popups.length, 0); assert.deepEqual(errors, []);
    if (process.env.CANVAS_HELPER_QA_DIR) {
      fs.mkdirSync(process.env.CANVAS_HELPER_QA_DIR, {recursive: true});
      await page.screenshot({path: path.join(process.env.CANVAS_HELPER_QA_DIR, "overview-desktop.png"), fullPage: true});
    }
    await page.locator(".intro-expand").first().click();
    assert.equal(await page.locator(".intro-expand").first().getAttribute("aria-expanded"), "false");
    await page.locator(".intro-expand").first().click();
    assert.equal(await page.locator(".course-description").first().evaluate(node => node.scrollHeight <= node.clientHeight + 1), true);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.locator(".course-description").first().evaluate(node => node.scrollHeight <= node.clientHeight + 1), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.CANVAS_HELPER_QA_DIR) await page.screenshot({path: path.join(process.env.CANVAS_HELPER_QA_DIR, "overview-mobile.png"), fullPage: true});
    console.log("overview browser: full text, inert launch HTML, active-course filter, real API/DOM flow, 1440/390 layouts and zero tab operations passed");
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
