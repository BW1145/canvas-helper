/* Optional browser fixtures: Playwright + Chromium. All requests use local fixtures. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require(require.resolve("playwright", {paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()]}));
const origin = "https://canvas.example.invalid";
const folder = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const video = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const panopto = "https://school.panopto.com";
const original = `Welcome to Planets, Stars and Galaxies

Astronomy begins with a familiar experience: looking up at the night sky and wondering what lies beyond it. In this course, we explore how observations of light help us understand worlds we cannot visit, from the planets in our own solar system to the most distant galaxies.

What will we study?

We begin close to home. You will investigate the motion of the Earth and Moon, the changing appearance of the sky, and the evidence that shapes our understanding of the solar system. We then turn to stars: how they form, how they produce energy, and how they change over their lifetimes. The final part of the course introduces galaxies, the expansion of the universe, and the questions astronomers are still working to answer.

Throughout the semester, the emphasis is on connecting ideas with evidence. A photograph of a nebula, a spectrum of a distant star, or a measurement of a planet's motion can tell us something different about the physical world. You will practise explaining what an observation supports, what it leaves uncertain, and how several observations can work together.

Learning each week

Before each lecture, read the short preparation notes in the weekly module. The lecture introduces the central ideas; the associated activities give you time to apply them. Recordings and slides will be available through the course resources. Use these to revisit difficult concepts and to check the reasoning behind your answers.

Tutorials are an opportunity to ask questions, compare approaches, and work through problems with other students. Bring your notes and a question you would like to discuss. You do not need to arrive with every answer: a clear explanation of where you got stuck is a useful starting point.

Assessment and feedback

Weekly activities provide regular feedback on your understanding. Written assignments ask you to explain astronomical ideas in your own words and interpret simple observations. Details of each task, including marking criteria and submission instructions, are provided in the Assignments area. Check the schedule there for the current deadlines.

Getting started

Begin with the first weekly module and the course outline. Introduce yourself in the discussion area, check that you can access the lecture recordings, and make a note of the tutorial arrangements. If you need help, use the course discussion board or contact the teaching team through Canvas.

We look forward to exploring the universe with you.`;
const names = {1: "ASTRO 100/100G: Planets, Stars and Galaxies", 2: "Composition Workshop", 3: "Music, Culture and Society", 4: "Harmony and Analysis", 5: "Performance and Interpretation", 6: "Introduction to Music Technology", 7: "Musicianship and Aural Skills", 8: "Research and Writing in the Arts", 9: "Past Course", 10: "Arts & Education Undergraduate Community", 11: "Creative Practice: Collaboration across Music, Performance and the Visual Arts", 12: "Special Topics in Composition"};
const activeIds = Object.keys(names).map(Number).filter(id => id !== 9);
const raw = id => ({id: String(id), name: names[id], course_code: id === 1 ? "ASTRO 100/100G" : `MUSIC ${id}01`, workflow_state: "available", default_view: "wiki",
  term: {id: id === 9 ? "20251" : "20262", name: id === 9 ? "2025 Academic Year Term" : "2026 Semester Two", start_at: "2025-01-01", end_at: "2027-01-01"}});

(async () => {
  const browser = await chromium.launch({headless: true, channel: process.env.CANVAS_HELPER_BROWSER_CHANNEL});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const popups = [], errors = [], requests = [];
  let failCourse = true, pauseFront = false, releaseFront;
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
    if (url.pathname === "/api/v1/courses") return route.fulfill({json: (url.searchParams.get("enrollment_state") === "active" ? activeIds : Object.keys(names).map(Number)).map(raw)});
    const front = url.pathname.match(/^\/api\/v1\/courses\/(\d+)\/front_page$/);
    if (front) {
      if (front[1] === "1" && pauseFront) await new Promise(resolve => {releaseFront = resolve;});
      if (front[1] === "12" && failCourse) return route.fulfill({status: 503, body: "Unavailable"});
      const body = (front[1] === "1" ? original : `Tēnā koutou! Welcome to ${names[front[1]]}.\n\nThis course develops your practical and critical skills through weekly workshops and discussion. Read the course outline for assessment details and use the weekly modules to prepare for each session.`)
        .split("\n\n").map(part => part.length < 45 ? `<h2>${part}</h2>` : `<p>${part}</p>`).join("");
      return route.fulfill({json: {published: true, body: body + '<h2>准备事项</h2><ol><li>阅读课程大纲</li><li>查看每周学习安排</li></ol><script>window.open("https://unrelated.invalid")</script><p hidden>hidden secret</p>', url: "welcome"}});
    }
    const tabs = url.pathname.match(/^\/api\/v1\/courses\/(\d+)\/tabs$/);
    if (tabs) return route.fulfill({json: Number(tabs[1]) > 3 ? [] : [{label: "Panopto Video", html_url: tabs[1] === "1"
      ? `${panopto}/Panopto/Pages/EmbeddedList.aspx?folderID=${folder}` : `${origin}/courses/${tabs[1]}/external_tools/42`}]});
    const tool = url.pathname.match(/^\/courses\/(\d+)\/external_tools\/42$/);
    if (tool) return route.fulfill({contentType: "text/html", body: tool[1] === "2"
      ? `<script>window.open('https://unrelated.invalid')</script><iframe src="${panopto}/Panopto/Pages/EmbeddedList.aspx?folderID=${folder}"></iframe>`
      : `<form method="post" action="${panopto}/Panopto/LTI/LTI.aspx"><input name="oauth_signature" value="fixture-secret"></form>`});
    const name = path.basename(url.pathname);
    if (!/^[\w.-]+\.(?:html|css|js)$/.test(name) || !fs.existsSync(path.join(__dirname, name))) return route.abort();
    return route.fulfill({contentType: name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html", body: fs.readFileSync(path.join(__dirname, name))});
  });
  async function screenshot(name) {
    if (!process.env.CANVAS_HELPER_QA_DIR) return;
    fs.mkdirSync(process.env.CANVAS_HELPER_QA_DIR, {recursive: true});
    await page.screenshot({path: path.join(process.env.CANVAS_HELPER_QA_DIR, name)});
  }
  async function noOverflow(label) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label);
    const reader = page.locator("#courseReader");
    if (await reader.isVisible()) assert.equal(await reader.evaluate(node => node.scrollWidth <= node.clientWidth), true, label + ": reader overflow");
  }
  try {
    await page.goto(`${origin}/courses.html?sourceTab=42`);
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("已整理"));
    assert.equal(await page.locator(".course-select").count(), 11);
    assert.equal(await page.locator("#courseReader").isVisible(), false);
    assert.equal(await page.locator("#progress").isVisible(), false);
    assert.equal(await page.locator("#stopBtn").isVisible(), false);
    assert.equal(await page.locator(".course-item").first().locator(".video-link").count(), 1);
    assert.equal(await page.locator(".row-retry").count(), 1);
    const beforeRetry = requests.length; failCourse = false;
    await page.locator(".row-retry").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("课程已更新"));
    assert.equal(await page.locator(".row-retry").count(), 0);
    assert.ok(requests.slice(beforeRetry).filter(url => /api\/v1\/courses\//.test(url)).every(url => url.includes("/12/")));
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await screenshot("canvas-helper-overview.png");
    const beforeSearch = requests.length;
    await page.locator("#courseSearch").fill("music composition");
    assert.equal(await page.locator(".course-select").count(), 2);
    await page.locator("#courseSearch").fill("does not exist");
    assert.equal(await page.locator(".course-select").count(), 0);
    assert.equal(await page.locator("#emptyTitle").textContent(), "没有匹配的课程");
    await page.locator("#clearSearchBtn").click();
    assert.equal(requests.length, beforeSearch);

    await page.evaluate(() => scrollTo(0, 0));
    await page.locator(".course-select").first().click();
    assert.equal(await page.evaluate(() => scrollY), 0, "opening details preserves the list position");
    assert.equal(await page.locator("#courseReader").getAttribute("role"), "complementary");
    assert.equal(await page.locator("#readerDescription h3").first().textContent(), "Welcome to Planets, Stars and Galaxies");
    assert.equal(await page.locator("#readerDescription ol li").count(), 2);
    const text = (await page.locator("#readerDescription").textContent()).replace(/\s+/g, " ");
    for (const paragraph of original.split("\n\n")) assert.ok(text.includes(paragraph.replace(/\s+/g, " ")), "all original text present");
    assert.equal(await page.locator("#readerDescription script, #readerDescription [hidden]").count(), 0);
    assert.doesNotMatch(text, /hidden secret/);
    assert.equal(await page.locator("#readerVideo").textContent(), "Panopto 有视频");
    await screenshot("canvas-helper-course-reader.png");
    await page.locator("#nextCourseBtn").click();
    assert.equal(await page.locator("#readerTitle").textContent(), names[2]);
    await page.locator("#nextCourseBtn").click();
    assert.equal(await page.locator("#readerVideo").textContent(), "Panopto 已找到入口");
    await page.locator("#closeReaderBtn").click();
    assert.equal(await page.locator(".course-select").nth(2).evaluate(node => node === document.activeElement), true);

    for (const width of [1920, 1440, 1200, 1199, 1024, 768, 540, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      await noOverflow(width + ": list");
      await page.locator(".course-select").nth(9).click();
      assert.equal(await page.locator("#readerTitle").textContent(), names[11]);
      await noOverflow(width + ": long title");
      if (width < 1200) {
        assert.equal(await page.locator("#courseReader").getAttribute("aria-modal"), "true");
        assert.equal(await page.locator("#listColumn").evaluate(node => node.inert), true);
        await page.locator("#closeReaderBtn").focus(); await page.keyboard.press("Shift+Tab");
        assert.equal(await page.locator("#readerSource").evaluate(node => node === document.activeElement), true);
        await page.keyboard.press("Tab");
        assert.equal(await page.locator("#closeReaderBtn").evaluate(node => node === document.activeElement), true);
      }
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#courseReader").isVisible(), false);
      assert.equal(await page.locator("#listColumn").evaluate(node => node.inert), false);
      await page.locator(".course-select").first().click();
      await page.locator("#courseReader").evaluate(node => {node.scrollTop = node.scrollHeight;});
      assert.equal(await page.locator("#readerDescription").evaluate(node => node.lastElementChild.getBoundingClientRect().bottom <= innerHeight + 1), true, width + ": end of introduction reachable");
      assert.ok((await page.locator("#closeReaderBtn").boundingBox()).y >= 0, "return remains reachable");
      await page.locator("#closeReaderBtn").click();
    }
    await page.setViewportSize({width: 390, height: 844}); await page.evaluate(() => scrollTo(0, 0));
    await screenshot("canvas-helper-overview-mobile.png");
    await page.locator(".course-select").nth(9).click();
    await screenshot("canvas-helper-reader-mobile.png");
    // Resizing an open reader preserves content and adjusts the modal boundary.
    await page.setViewportSize({width: 1440, height: 1000});
    assert.equal(await page.locator("#listColumn").evaluate(node => node.inert), false);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.locator("#closeReaderBtn").evaluate(node => node === document.activeElement), true);
    await page.locator("#closeReaderBtn").click();

    assert.equal(requests.some(url => /courses\/9\//.test(url)), false, "past course was not requested in the current semester");
    await page.locator("#termSelect").selectOption("all");
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("已整理"));
    assert.equal(await page.locator(".course-select").count(), 12);
    await page.locator("#termSelect").selectOption("current");
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("已整理"));
    assert.equal(await page.locator(".course-select").count(), 11);
    await page.locator(".course-select").first().focus(); await page.keyboard.press("Enter");
    assert.equal(await page.locator("#readerTitle").textContent(), names[1]);
    await page.locator("#closeReaderBtn").click();
    await page.setViewportSize({width: 320, height: 640});
    pauseFront = true;
    await page.locator("#refreshBtn").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("正在读取介绍"));
    await noOverflow("320: loading toolbar");
    assert.equal(await page.locator("#stopBtn").isVisible(), true);
    await page.locator("#stopBtn").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("已停止"));
    releaseFront?.();
    assert.equal(await page.locator("#stopBtn").isVisible(), false);
    assert.equal(requests.some(url => /LTI\.aspx|unrelated\.invalid/.test(url)), false);
    assert.equal(popups.length, 0); assert.deepEqual(errors, []);
    console.log("overview browser: search, per-course retry, structured full text, 9 widths (320–1920), keyboard/modal focus, semester switching and zero tab operations passed");
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
