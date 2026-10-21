import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const html = readFileSync(new URL("./courses.html", import.meta.url), "utf8");
const source = readFileSync(new URL("./courses.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const origin = "https://canvas.example.edu";
const makeCourse = (id, termKey = "term:2") => ({id: String(id), name: `课程 ${id}`, code: `MUSIC ${id}`, url: `${origin}/courses/${id}`, termKey, termName: termKey === "term:2" ? "2026 Semester Two" : "2026 Semester One"});
const defaultCatalog = () => ({ok: true, origin, courses: [makeCourse(1), makeCourse(2), makeCourse(9, "term:1")],
  terms: [{key: "term:2", name: "2026 Semester Two"}, {key: "term:1", name: "2026 Semester One"}],
  currentIds: ["1", "2"], dashboardIds: ["1", "2", "9"], defaultScope: "current", notice: ""});
const defaultDetail = (id) => ({ok: true, id, intro: {text: `这门课程研究音乐 ${id}。\n课程目标：理解和声与作品结构。`, state: "ready", sourceLabel: "课程首页", url: `${origin}/courses/${id}/pages/welcome`},
  panoptoLinks: [{url: `${origin}/courses/${id}/external_tools/20`, label: "Panopto Video", kind: "tool"}], navigationState: "ready"});

function harness(options = {}) {
  const controls = new Map(), calls = [], trace = [], probes = [], windowEvents = {};
  const document = {activeElement: null};
  function element(tag) {
    let text = "";
    return {tag, children: [], dataset: {}, attributes: {}, events: {}, className: "", value: "",
      textWrites: 0, get textContent() {return text || this.children.map(child => child.textContent).join("");},
      set textContent(value) {this.textWrites++; text = String(value); this.children = [];},
      set innerHTML(_) {throw new Error("Course content must remain inert text.");},
      setAttribute(name, value) {this.attributes[name] = value;},
      addEventListener(name, handler) {this.events[name] = handler;},
      append(...nodes) {this.children.push(...nodes.flatMap(node => node.tag === "#fragment" ? node.children : [node]));},
      replaceChildren(...nodes) {text = ""; this.children = []; this.append(...nodes);},
      focus() {document.activeElement = this;}
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) controls.set(id, element("control"));
  document.getElementById = id => controls.get(id);
  document.createElement = element;
  document.createDocumentFragment = () => element("#fragment");
  const context = {document, URL, AbortController, DOMException,
    location: {href: `chrome-extension://fixture/courses.html${options.noSource ? "" : "?sourceTab=42"}`},
    window: {addEventListener(type, handler) {windowEvents[type] = handler;}},
    chrome: {scripting: {async executeScript(request) {
      assert.equal(request.target.tabId, 42); assert.equal(request.world, "ISOLATED");
      if (request.files) {calls.push(["inject", ...request.files]); trace.push("inject"); return [];}
      const [method, args] = request.args;
      calls.push([method, ...args]); trace.push(`${method}:${args.join(",")}`);
      if (options.execute) {
        const result = await options.execute(method, args);
        if (result !== undefined) return [{result}];
      }
      return [{result: method === "getCatalog" ? options.catalog || defaultCatalog() : options.detail ? await options.detail(args[0]) : defaultDetail(args[0])}];
    }}},
    async probeCourseVideo(course, request) {
      probes.push({course, ...request}); trace.push(`probe:${course.id}`);
      return options.probe ? options.probe(course, request) : {status: "available", count: 4, url: `${origin}/courses/${course.id}/external_tools/20`, message: ""};
    },
    async cancelVideoProbe() {trace.push("close-probe");}
  };
  vm.runInNewContext(source + "\nglobalThis.testApi = {state, requestRun, render, visibleCourses, selectCourse};", context);
  return {api: context.testApi, controls, calls, probes, trace, document, windowEvents,
    async done() {await context.testApi.state.activeRun;},
    grid() {return controls.get("courseList").children;}};
}
function descend(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {const found = descend(child, predicate); if (found) return found;}
  return null;
}
function byClass(node, className) {return descend(node, item => item.className?.split(" ").includes(className));}
async function until(check) {
  for (let count = 0; count < 50; count++) {if (check()) return; await new Promise(resolve => setImmediate(resolve));}
  assert.fail("Expected asynchronous checkpoint was not reached.");
}

test("loads current course introductions and opens a full-width reader with the first course selected", async () => {
  const h = harness(); await h.done();
  assert.deepEqual(h.calls, [["inject", "canvas-client.js"], ["getCatalog"], ["getCourse", "1"], ["getCourse", "2"]]);
  assert.equal(h.grid().length, 2); assert.equal(h.api.state.selectedId, "1");
  assert.match(h.controls.get("readerDescription").textContent, /这门课程研究音乐 1/);
  assert.match(h.controls.get("readerVideo").textContent, /4 个视频/);
  assert.equal(h.controls.get("progress").value, 100);
  assert.equal(h.controls.get("courseReader").hidden, false);
});

test("course selection and next/previous navigation show cached full introductions", async () => {
  const h = harness(); await h.done(); const count = h.calls.length;
  h.controls.get("nextCourseBtn").events.click();
  assert.equal(h.api.state.selectedId, "2"); assert.match(h.controls.get("readerDescription").textContent, /音乐 2/);
  assert.equal(h.controls.get("nextCourseBtn").disabled, true);
  assert.equal(h.controls.get("prevCourseBtn").disabled, false);
  h.controls.get("prevCourseBtn").events.click(); assert.equal(h.api.state.selectedId, "1");
  const button = byClass(h.grid()[1], "course-select"); button.events.click();
  assert.equal(h.api.state.selectedId, "2"); assert.equal(h.calls.length, count);
  assert.equal(byClass(h.grid()[1], "course-select").attributes["aria-current"], "true");
});

test("long original text remains inert and stable while other course statuses update", async () => {
  const original = "<img src=x onerror=alert(1)>\n" + "课程完整介绍。".repeat(300);
  const h = harness({detail(id) {const detail = defaultDetail(id); detail.intro.text = original; return detail;}}); await h.done();
  const node = h.controls.get("readerDescription"), writes = node.textWrites;
  assert.equal(node.textContent, original); assert.doesNotMatch(node.className, /collapsed/);
  h.api.state.cache.get("2").video.message = "后台状态更新"; h.api.render();
  assert.equal(node.textWrites, writes, "retain the current text node and browser selection");
  assert.equal(node.children.length, 0); assert.equal(node.textContent, original);
});

test("directory focus and scroll position survive background updates", async () => {
  const h = harness(); await h.done();
  const button = byClass(h.grid()[1], "course-select"); button.focus(); h.controls.get("courseList").scrollTop = 180;
  h.api.state.cache.get("1").video.message = "更新"; h.api.render();
  assert.equal(h.document.activeElement, byClass(h.grid()[1], "course-select"));
  assert.equal(h.controls.get("courseList").scrollTop, 180);
});

test("mobile directory opens explicitly and closes after choosing a course", async () => {
  const h = harness(); await h.done();
  h.controls.get("directoryToggle").events.click();
  assert.equal(h.controls.get("directoryToggle").attributes["aria-expanded"], "true");
  byClass(h.grid()[1], "course-select").events.click();
  assert.equal(h.controls.get("directoryToggle").attributes["aria-expanded"], "false");
  assert.equal(h.controls.get("selectedCourseLabel").textContent, "MUSIC 2");
});

test("changing semester selects a visible course and returning reuses cached content", async () => {
  const h = harness(); await h.done(); await h.api.requestRun({scope: "term:1"});
  assert.equal(h.grid().length, 1); assert.equal(h.api.state.selectedId, "9");
  assert.match(h.controls.get("readerTitle").textContent, /课程 9/);
  const count = h.calls.length, probes = h.probes.length;
  await h.api.requestRun({scope: "current"}); assert.equal(h.calls.length, count); assert.equal(h.probes.length, probes);
  h.controls.get("refreshBtn").events.click(); await h.done();
  assert.equal(h.calls.filter(call => call[0] === "getCatalog").length, 2);
});

test("unknown dates explicitly use the Dashboard scope", async () => {
  const catalog = defaultCatalog(); catalog.currentIds = []; catalog.defaultScope = "dashboard"; catalog.notice = "日期不明，显示 Dashboard 课程。";
  const h = harness({catalog}); await h.done();
  assert.equal(h.api.state.scope, "dashboard"); assert.equal(h.grid().length, 3);
  assert.equal(h.controls.get("scopeNotice").textContent, catalog.notice);
});

test("video evidence and unreadable introductions retain their separate states", async () => {
  const h = harness({detail(id) {const detail = defaultDetail(id); if (id === "1") detail.intro = {state: "error", message: "首页读取失败", text: ""}; return detail;},
    probe(course) {return {status: course.id === "1" ? "available" : "empty", count: null, url: null, message: ""};}}); await h.done();
  assert.match(h.controls.get("readerDescription").textContent, /首页读取失败/);
  assert.match(h.controls.get("readerVideo").textContent, /有视频/);
  h.api.selectCourse("2"); assert.match(h.controls.get("readerVideo").textContent, /暂无视频/);
});

test("interactive entrances stay discoverable and every course continues checking", async () => {
  const h = harness({probe(course) {return {status: "linked", count: null, url: `${origin}/courses/${course.id}/external_tools/20`, message: "请打开视频列表查看。"};}}); await h.done();
  assert.equal(h.probes.length, 2); assert.match(h.controls.get("readerVideo").textContent, /已找到入口/);
  assert.ok(byClass(h.controls.get("readerLinks"), "video-link"));
  assert.doesNotMatch(h.controls.get("status").textContent, /未能读取/);
});

test("unsafe or unrelated URLs are never rendered as reader actions", async () => {
  const catalog = defaultCatalog(); catalog.courses[0].url = "javascript:alert(1)";
  const h = harness({catalog, detail(id) {const detail = defaultDetail(id); detail.intro.url = "https://outside.invalid/steal"; return detail;},
    probe() {return {status: "available", count: 1, url: "https://canvas.example.edu/courses/999/external_tools/20", message: ""};}}); await h.done();
  assert.equal(h.controls.get("readerLinks").children.length, 0); assert.equal(h.controls.get("readerSource").hidden, true);
});

test("stop and semester changes cancel checks while the reader remains usable", async () => {
  let first = true;
  const h = harness({probe(course, {signal}) {if (first) {first = false; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {once: true}));} return {status: "empty", count: 0, url: null, message: ""};}});
  await until(() => h.probes.length === 1); h.api.selectCourse("2");
  assert.match(h.controls.get("readerDescription").textContent, /音乐 2/);
  h.controls.get("stopBtn").events.click(); await h.done();
  assert.equal(h.probes[0].signal.aborted, true); assert.equal(h.api.state.busy, false);
  await h.api.requestRun({scope: "term:1"}); assert.equal(h.api.state.selectedId, "9");
});

test("late source results cannot overwrite a stopped run", async () => {
  let release;
  const h = harness({detail(id) {if (id === "1") return new Promise(resolve => {release = () => resolve(defaultDetail(id));}); return defaultDetail(id);}});
  await until(() => Boolean(release)); h.controls.get("stopBtn").events.click(); await h.done(); release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.probes.length, 0);
  assert.equal(h.api.state.cache.get("1").detail, null); assert.match(h.controls.get("status").textContent, /已停止/);
});

test("authentication and rate pauses preserve loaded introductions", async () => {
  for (const code of ["AUTH_REQUIRED", "RATE_LIMIT"]) {
    const h = harness({probe() {return {status: "error", code, url: null, message: "请登录或稍后重新读取。"};}}); await h.done();
    assert.equal(h.probes.length, 1); assert.match(h.controls.get("status").textContent, /重新读取/);
    h.api.selectCourse("2"); assert.match(h.controls.get("readerDescription").textContent, /音乐 2/);
  }
});

test("missing source and empty scope show clear reader states", async () => {
  const absent = harness({noSource: true}); await absent.done();
  assert.equal(absent.calls.length, 0); assert.equal(absent.controls.get("refreshBtn").disabled, true);
  const catalog = defaultCatalog(); catalog.courses = []; catalog.currentIds = []; catalog.dashboardIds = [];
  const h = harness({catalog}); await h.done();
  assert.equal(h.controls.get("courseReader").hidden, true); assert.equal(h.controls.get("emptyState").hidden, false);
});

test("pagehide cancels background work and every control belongs to the overview stylesheet", async () => {
  const h = harness(); await h.done();
  for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(h.controls.has(id), id);
  assert.match(html, /href="courses\.css"/); assert.doesNotMatch(html, /dashboard\.css/);
  h.windowEvents.pagehide(); assert.equal(h.trace.at(-1), "close-probe");
});
