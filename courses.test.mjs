import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const html = readFileSync(new URL("./courses.html", import.meta.url), "utf8");
const source = readFileSync(new URL("./courses.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
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
      get textContent() {return text || this.children.map(child => child.textContent).join("");},
      set textContent(value) {text = String(value); this.children = [];},
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
    async closeProbeTab() {trace.push("close-probe");}
  };
  vm.runInNewContext(source + "\nglobalThis.testApi = {state, requestRun, render, visibleCourses};", context);
  return {api: context.testApi, controls, calls, probes, trace, document, windowEvents,
    async done() {await context.testApi.state.activeRun;},
    grid() {return controls.get("courseGrid").children;}};
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

test("opens automatically, reads all current introductions before any video redirect, and leaves old courses unread", async () => {
  const h = harness(); await h.done();
  assert.deepEqual(h.calls, [["inject", "canvas-client.js"], ["getCatalog"], ["getCourse", "1"], ["getCourse", "2"]]);
  assert.deepEqual(h.trace, ["inject", "getCatalog:", "getCourse:1", "getCourse:2", "probe:1", "probe:2", "close-probe"]);
  assert.equal(h.grid().length, 2);
  assert.match(h.grid()[0].textContent, /这门课程研究音乐 1/);
  assert.match(h.grid()[0].textContent, /Panopto · 4 个视频/);
  assert.equal(h.controls.get("termSelect").value, "current");
  assert.equal(h.controls.get("progress").value, 100);
  assert.equal(h.controls.get("stopBtn").disabled, true);
  assert.equal(h.controls.get("refreshBtn").disabled, false);
});

test("semester selection requests only its new courses and returning to the current scope uses cached cards", async () => {
  const h = harness(); await h.done();
  h.controls.get("termSelect").value = "term:1";
  h.controls.get("termSelect").events.change(); await h.done();
  assert.equal(h.grid().length, 1); assert.match(h.grid()[0].textContent, /课程 9/);
  assert.deepEqual(h.calls.at(-1), ["getCourse", "9"]);
  const before = h.calls.length, probes = h.probes.length;
  await h.api.requestRun({scope: "current"});
  assert.equal(h.grid().length, 2); assert.equal(h.calls.length, before); assert.equal(h.probes.length, probes);
  h.controls.get("refreshBtn").events.click(); await h.done();
  assert.equal(h.calls.filter(call => call[0] === "getCatalog").length, 2);
  assert.equal(h.probes.length, probes + 2);
});

test("no-date fallback selects Dashboard explicitly and shows the client notice", async () => {
  const catalog = defaultCatalog(); catalog.currentIds = []; catalog.defaultScope = "dashboard"; catalog.notice = "学校未提供学期日期，先显示 Dashboard 上的课程。";
  const h = harness({catalog}); await h.done();
  assert.equal(h.api.state.scope, "dashboard"); assert.equal(h.grid().length, 3);
  assert.equal(h.controls.get("scopeNotice").hidden, false);
  assert.equal(h.controls.get("scopeNotice").textContent, catalog.notice);
  assert.ok(!h.controls.get("termSelect").children.some(option => option.value === "current"));
});

test("empty, missing entrance, and failed reads remain distinct; a failed intro can still have video", async () => {
  const catalog = defaultCatalog(); catalog.courses.push(makeCourse(3)); catalog.currentIds.push("3");
  const h = harness({catalog, detail(id) {
    const result = defaultDetail(id);
    if (id === "1") result.intro = {state: "error", text: "", message: "首页暂时读取失败。", sourceLabel: "课程首页", url: result.intro.url};
    return result;
  }, probe(course) {return {status: ({1: "available", 2: "empty", 3: "error"})[course.id], count: null, url: null, message: course.id === "3" ? "学校登录已过期。" : ""};}});
  await h.done();
  assert.match(h.grid()[0].textContent, /首页暂时读取失败/); assert.match(h.grid()[0].textContent, /Panopto · 有视频/);
  assert.match(h.grid()[1].textContent, /Panopto · 暂无视频/);
  assert.match(h.grid()[2].textContent, /Panopto · 读取失败/); assert.doesNotMatch(h.grid()[2].textContent, /暂无视频|未发现入口/);
  h.api.state.cache.get("3").video = {status: "not_found", count: null, url: null, message: ""}; h.api.render();
  assert.match(h.grid()[2].textContent, /Panopto · 未发现入口/);
});

test("long original text stays inert, expands intact, and keeps expansion and focus across updates", async () => {
  const original = "<img src=x onerror=alert(1)>\n" + "这一段是教师的完整原文。".repeat(28);
  const h = harness({detail(id) {const detail = defaultDetail(id); detail.intro.text = original; return detail;}});
  await h.done();
  let card = h.grid()[0], description = byClass(card, "course-description"), expand = byClass(card, "intro-expand");
  assert.equal(description.textContent, original); assert.ok(description.className.includes("is-collapsed"));
  assert.equal(descend(card, node => node.tag === "img"), null);
  expand.focus(); expand.events.click();
  card = h.grid()[0]; description = byClass(card, "course-description"); expand = byClass(card, "intro-expand");
  assert.equal(description.textContent, original); assert.ok(!description.className.includes("is-collapsed"));
  assert.equal(expand.attributes["aria-expanded"], "true"); assert.equal(h.document.activeElement, expand);
  h.api.state.cache.get("2").video.message = "另一门课状态更新。"; h.api.render();
  assert.equal(byClass(h.grid()[0], "course-description").textContent, original);
  assert.equal(byClass(h.grid()[0], "intro-expand").attributes["aria-expanded"], "true");
  assert.equal(h.document.activeElement, byClass(h.grid()[0], "intro-expand"));
});

test("unsafe or unrelated links are not rendered as course or video actions", async () => {
  const catalog = defaultCatalog(); catalog.courses[0].url = "javascript:alert(1)";
  const h = harness({catalog, detail(id) {const detail = defaultDetail(id); detail.intro.url = "https://outside.example/steal"; return detail;},
    probe() {return {status: "available", count: 1, url: "https://canvas.example.edu/courses/999/external_tools/20", message: ""};}});
  await h.done();
  assert.equal(byClass(h.grid()[0], "course-home-link"), null);
  assert.equal(byClass(h.grid()[0], "intro-source"), null);
  assert.equal(byClass(h.grid()[0], "video-link"), null);
  assert.equal(byClass(h.grid()[1], "video-link"), null);
  assert.ok(byClass(h.grid()[1], "course-home-link"));
});

test("stop during a stalled video probe retains all introductions and cleans the temporary tab", async () => {
  const h = harness({probe(_course, {signal}) {return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {once: true}));}});
  await until(() => h.probes.length === 1);
  assert.ok(h.grid().every(card => /课程目标/.test(card.textContent)));
  h.controls.get("stopBtn").events.click(); await h.done();
  assert.equal(h.probes.length, 1); assert.equal(h.probes[0].signal.aborted, true);
  assert.equal(h.trace.at(-1), "close-probe"); assert.equal(h.api.state.busy, false);
  assert.match(h.controls.get("status").textContent, /已停止/);
  assert.ok(h.grid().every(card => /课程目标/.test(card.textContent)));
  assert.doesNotMatch(h.grid()[0].textContent, /暂无视频|读取失败/);
});

test("switching semesters cancels the old probe and closes it before inspecting the next semester", async () => {
  let first = true;
  const h = harness({probe(course, {signal}) {
    if (first) {first = false; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {once: true}));}
    return {status: "empty", count: 0, url: `${origin}/courses/${course.id}/external_tools/20`, message: ""};
  }});
  await until(() => h.probes.length === 1);
  await h.api.requestRun({scope: "term:1"});
  assert.equal(h.probes[0].signal.aborted, true);
  assert.ok(h.trace.indexOf("close-probe") < h.trace.indexOf("probe:9"));
  assert.equal(h.grid().length, 1); assert.match(h.grid()[0].textContent, /课程 9/);
  assert.equal(h.api.state.scope, "term:1");
});

test("late Canvas results after stop do not start video checks or overwrite stopped state", async () => {
  let release;
  const h = harness({detail(id) {if (id === "1") return new Promise(resolve => {release = () => resolve(defaultDetail(id));}); return defaultDetail(id);}});
  await until(() => Boolean(release));
  h.controls.get("stopBtn").events.click(); await h.done(); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.probes.length, 0); assert.equal(h.calls.filter(call => call[0] === "getCourse").length, 1);
  assert.equal(h.api.state.cache.get("1").detail, null); assert.match(h.controls.get("status").textContent, /已停止/);
});

test("Canvas auth and rate errors pause once with actionable text, never as missing video", async () => {
  for (const code of ["AUTH_REQUIRED", "RATE_LIMIT"]) {
    const h = harness({detail() {return {ok: false, code, message: code === "AUTH_REQUIRED" ? "请在 Canvas 完成登录后重新读取。" : "请求过多，请稍后重新读取。"};}});
    await h.done();
    assert.equal(h.calls.filter(call => call[0] === "getCourse").length, 1); assert.equal(h.probes.length, 0);
    assert.match(h.controls.get("status").textContent, /重新读取/);
    assert.match(h.grid()[0].textContent, /读取失败/); assert.doesNotMatch(h.grid()[0].textContent, /未发现入口|暂无视频/);
  }
});

test("Panopto login or rate result pauses later probes while preserving every loaded introduction", async () => {
  for (const code of ["LOGIN_REQUIRED", "AUTH_REQUIRED", "RATE_LIMIT"]) {
    const h = harness({probe(course) {return {status: "error", code, count: null, url: `${origin}/courses/${course.id}/external_tools/20`, message: code === "RATE_LIMIT" ? "请求过多，请稍后点“重新读取”。" : "请完成学校登录后点“重新读取”。"};}});
    await h.done();
    assert.deepEqual(h.calls.filter(call => call[0] === "getCourse").map(call => call[1]), ["1", "2"]);
    assert.equal(h.probes.length, 1); assert.equal(h.api.state.cache.get("2").phase, "ready");
    assert.ok(h.grid().every(card => /课程目标/.test(card.textContent)));
    assert.match(h.grid()[0].textContent, /读取失败/); assert.match(h.grid()[1].textContent, /等待检查/);
    assert.ok(byClass(h.grid()[0], "video-link"), "keep the verified entrance available for login");
    assert.match(h.controls.get("status").textContent, /重新读取/);
    assert.equal(h.trace.at(-1), "close-probe");
  }
});

test("a refreshed source reinjects the client once and missing source fails without network", async () => {
  let missing = true;
  const h = harness({execute(method) {if (method === "getCourse" && missing) {missing = false; return {ok: false, code: "CLIENT_MISSING"};}}});
  await h.done(); assert.equal(h.calls.filter(call => call[0] === "inject").length, 2); assert.equal(h.probes.length, 2);
  const absent = harness({noSource: true}); await absent.done();
  assert.equal(absent.calls.length, 0); assert.equal(absent.probes.length, 0);
  assert.match(absent.controls.get("status").textContent, /Dashboard/);
  assert.equal(absent.controls.get("refreshBtn").disabled, true);
});

test("controls and stylesheet references are complete and pagehide requests cleanup", async () => {
  const h = harness(); await h.done();
  for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(h.controls.has(id), id);
  assert.match(html, /href="dashboard\.css"/); assert.match(html, /href="courses\.css"/);
  assert.match(html, /type="module" src="courses\.js"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  h.windowEvents.pagehide(); assert.equal(h.trace.at(-1), "close-probe");
});
