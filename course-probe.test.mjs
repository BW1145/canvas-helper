import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {probeCourseVideo, closeProbeTab} from "./course-probe.js";

const folderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const videoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const origin = "https://school.au.panopto.com";
const listUrl = `${origin}/Panopto/Pages/EmbeddedList.aspx?folderID=${folderId}&token=fixture-secret`;
const viewerUrl = `${origin}/Panopto/Pages/Viewer.aspx?id=${videoId}&auth=fixture-secret`;
const course = (id = 1, extra = {}) => ({id: String(id), url: `https://canvas.example/courses/${id}`, navigationState: "ready",
  panoptoLinks: [{url: `https://canvas.example/courses/${id}/external_tools/42?launch=fixture-secret`, kind: "tool"}], ...extra});

function event() {
  const listeners = new Set();
  return {addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback),
    emit: (...args) => [...listeners].forEach(callback => callback(...args)), get count() { return listeners.size; }};
}

function fixture(options = {}) {
  let id = 100, generation = 0, round = 0, startedAt = 0;
  const state = {trace: [], created: [], removed: [], scanOptions: [], scripts: [], scans: 0, oldTimeOrigin: null};
  const tabs = new Map();
  const onUpdated = event(), onRemoved = event(), onActivated = event();
  const runtime = {
    getURL(path) { return `chrome-extension://fixture/${path}`; },
    async sendMessage(message) {
      assert.equal(message.type, "PBT_DISCOVER");
      round++;
      state.trace.push(`discover:${generation}:${round}`);
      if (options.discover) return options.discover({message, generation, round, startedAt, state, onActivated, tabs});
      return {frames: [{tabId: message.tabId, frameId: 3, origin,
        path: options.viewer ? "/Panopto/Pages/Viewer.aspx" : "/Panopto/Pages/EmbeddedList.aspx"}]};
    }
  };
  const chrome = {runtime, tabs: {
    onUpdated, onRemoved, onActivated,
    async create(info) {
      const tab = {id: ++id, url: info.url, active: info.active, status: "complete"};
      tabs.set(tab.id, tab); state.created.push(tab.id); state.trace.push("create"); return {...tab};
    },
    async update(tabId, info) {
      const tab = tabs.get(tabId); if (!tab) throw Error("No tab");
      Object.assign(tab, info);
      if (info.url) {
        const reset = info.url.startsWith("chrome-extension://fixture/probe-reset.html?");
        state.trace.push(reset ? "reset" : `launch:${new URL(info.url).pathname}`);
        tab.status = "loading"; onUpdated.emit(tabId, {status: "loading"});
        if (!reset) { generation++; round = 0; startedAt = Date.now(); }
        tab.status = "complete"; onUpdated.emit(tabId, {status: "complete", url: info.url});
      }
      const result = {...tab};
      if (options.redactTabUrls) delete result.url;
      return result;
    },
    async get(tabId) { if (!tabs.has(tabId)) throw Error("No tab"); return {...tabs.get(tabId)}; },
    async remove(tabId) { state.removed.push(tabId); tabs.delete(tabId); onRemoved.emit(tabId); },
    async sendMessage(tabId, message, target) {
      assert.equal(message.type, "PBT_SCAN");
      assert.ok(tabs.has(tabId));
      assert.equal(target.documentId, `doc-${generation}`);
      state.scans++; state.scanOptions.push(target);
      const scan = {href: listUrl, origin, folderId,
        sessions: [{id: videoId, sources: ["viewer-link"]}],
        pagination: {confidence: "high", total: 8, countMatchesRange: true, complete: false, controlConflict: false}};
      return {ok: true, scan: options.scan ? options.scan({scan, generation, round, state}) : scan};
    }
  }, scripting: {
    async executeScript(request) {
      state.scripts.push(request.func);
      const evidence = {href: options.viewer ? viewerUrl : listUrl, timeOrigin: startedAt + 1,
        ready: true, complete: true, playerReady: false, error: null, busy: false, explicitEmpty: false, filtered: false};
      const result = options.evidence ? options.evidence({evidence, generation, round, startedAt, state, frameId: request.target.frameIds[0]}) : evidence;
      return [{frameId: request.target.frameIds[0], documentId: `doc-${generation}`, result}];
    }
  }};
  return {chrome, state, tabs, onActivated, onUpdated, onRemoved};
}

async function withFixture(options, run) {
  const previous = globalThis.chrome;
  const f = fixture(options);
  globalThis.chrome = f.chrome;
  try { await run(f); }
  finally { await closeProbeTab(); globalThis.chrome = previous; }
}

test("no entrance and failed navigation remain different, and unsafe launch URLs are never opened", async () => {
  await withFixture({}, async f => {
    assert.equal((await probeCourseVideo(course(1, {panoptoLinks: []}))).status, "not_found");
    assert.equal((await probeCourseVideo(course(1, {panoptoLinks: [], navigationState: "error"}))).status, "error");
    for (const url of ["javascript:alert(1)", "http://school.panopto.com/Panopto/Pages/Viewer.aspx?id=" + videoId,
      "https://canvas.example/courses/2/external_tools/42", "https://evilpanopto.com/Panopto/Pages/Viewer.aspx?id=" + videoId,
      "https://user:password@school.panopto.com/Panopto/Pages/Viewer.aspx?id=" + videoId,
      "https://school.panopto.com/Panopto/Pages/Sessions/List.aspx"]) {
      assert.equal((await probeCourseVideo(course(1, {panoptoLinks: [{url}]}))).status, "error", url);
    }
    assert.deepEqual(f.state.created, []);
  });
});

test("actual list cards prove videos, trustworthy pagination provides a total, and returned LTI link drops secrets", async () => {
  await withFixture({}, async f => {
    const result = await probeCourseVideo(course());
    assert.deepEqual(result, {status: "available", count: 8, url: "https://canvas.example/courses/1/external_tools/42", message: ""});
    assert.equal(f.state.scans, 1);
    assert.equal(f.state.scanOptions[0].documentId, "doc-1");
    assert.equal(f.tabs.get(f.state.created[0]).muted, true);
    assert.equal(f.tabs.get(f.state.created[0]).active, false);
  });
});

test("one tab is reused behind a full-document barrier without Tab.url; previous-course evidence is rejected", async () => {
  await withFixture({
    redactTabUrls: true,
    evidence({evidence, generation, round, state}) {
      if (generation === 1) state.oldTimeOrigin = evidence.timeOrigin - 1000;
      if (generation === 2 && round === 1) return {...evidence, timeOrigin: state.oldTimeOrigin};
      return evidence;
    },
    scan({scan, generation, round}) {
      if (generation === 2) scan.pagination.total = round === 1 ? 99 : 3;
      return scan;
    }
  }, async f => {
    assert.equal((await probeCourseVideo(course(1))).count, 8);
    assert.equal((await probeCourseVideo(course(2))).count, 3);
    assert.equal(f.state.created.length, 1);
    assert.equal(f.state.scans, 2, "the stale document was never asked to supply a scan");
    const secondLaunch = f.state.trace.indexOf("launch:/courses/2/external_tools/42");
    assert.equal(f.state.trace[secondLaunch - 1], "reset");
  });
});

test("uncertain totals are omitted and additional course entrances do not imply a full course count", async () => {
  await withFixture({scan({scan}) { scan.pagination.confidence = "conflicting"; return scan; }}, async () => {
    assert.equal((await probeCourseVideo(course())).count, null);
  });
  await withFixture({}, async () => {
    const c = course(); c.panoptoLinks.push({url: viewerUrl, kind: "video"});
    assert.equal((await probeCourseVideo(c)).count, null);
  });
});

test("a Viewer URL alone is not video evidence, while an actual loaded player is", async () => {
  await withFixture({viewer: true}, async f => {
    const c = course(1, {panoptoLinks: [{url: viewerUrl, kind: "video"}]});
    assert.equal((await probeCourseVideo(c, {timeoutMs: 100})).status, "error");
    assert.equal(f.state.scans, 0, "the collector's synthetic current-viewer session is never used");
  });
  await withFixture({viewer: true, evidence({evidence}) { return {...evidence, playerReady: true}; }}, async () => {
    const result = await probeCourseVideo(course(1, {panoptoLinks: [{url: viewerUrl, kind: "video"}]}));
    assert.equal(result.status, "available");
    assert.equal(result.count, null);
    assert.equal(result.url, `${origin}/Panopto/Pages/Viewer.aspx?id=${videoId}`);
  });
});

test("access and login errors take precedence over apparent videos and never become empty", async () => {
  for (const error of ["LOGIN_REQUIRED", "ACCESS_DENIED", "VIDEO_UNAVAILABLE"]) {
    await withFixture({evidence({evidence}) { return {...evidence, playerReady: true, error}; }}, async f => {
      const result = await probeCourseVideo(course());
      assert.equal(result.status, "error"); assert.equal(result.count, null); assert.equal(f.state.scans, 0);
      assert.equal(result.code, error);
      assert.ok(!result.message.includes("fixture-secret"));
    });
  }
});

test("a Panopto Login frame is inspected and reports authentication distinctly", async () => {
  await withFixture({
    discover({message}) { return {frames: [{tabId: message.tabId, frameId: 3, origin, path: "/Panopto/Pages/Auth/Login.aspx"}]}; },
    evidence({evidence}) { return {...evidence, href: `${origin}/Panopto/Pages/Auth/Login.aspx`, error: "LOGIN_REQUIRED"}; }
  }, async f => {
    const result = await probeCourseVideo(course());
    assert.equal(result.status, "error"); assert.equal(result.code, "LOGIN_REQUIRED"); assert.equal(f.state.scans, 0);
  });
});

test("login, authentication and rate-limit failures stop further candidate launches and keep their codes", async () => {
  for (const code of ["LOGIN_REQUIRED", "AUTH_REQUIRED", "RATE_LIMIT"]) {
    const options = code === "LOGIN_REQUIRED"
      ? {evidence({evidence}) { return {...evidence, error: code}; }}
      : {discover() { throw Object.assign(new Error("需要稍后重新检查。"), {code}); }};
    await withFixture(options, async f => {
      const c = course();
      c.panoptoLinks.push({url: "https://canvas.example/courses/1/external_tools/43?auth=fixture-secret", kind: "tool"});
      const result = await probeCourseVideo(c);
      assert.equal(result.status, "error"); assert.equal(result.code, code);
      assert.equal(result.url, "https://canvas.example/courses/1/external_tools/42");
      assert.deepEqual(f.state.trace.filter(value => value.startsWith("launch:")), ["launch:/courses/1/external_tools/42"]);
    });
  }
});

test("an overall course timeout preserves the last canonical entrance without signed parameters", async () => {
  const realNow = Date.now;
  await withFixture({discover() {
    Date.now = () => realNow() + 30000;
    return {frames: []};
  }}, async f => {
    try {
      const c = course();
      c.panoptoLinks.push({url: "https://canvas.example/courses/1/external_tools/43?auth=fixture-secret", kind: "tool"});
      const result = await probeCourseVideo(c, {timeoutMs: 100});
      assert.equal(result.status, "error"); assert.equal(result.code, "PROBE_TIMEOUT");
      assert.equal(result.url, "https://canvas.example/courses/1/external_tools/42");
      assert.ok(!JSON.stringify(result).includes("fixture-secret"));
      assert.equal(f.state.trace.filter(value => value.startsWith("launch:")).length, 1);
    } finally { Date.now = realNow; }
  });
});

test("confirmed empty list must remain stable after load, while loading/search-filtered zeroes stay unknown", async () => {
  const zero = ({scan}) => ({...scan, sessions: [], pagination: {confidence: "high", total: 0, complete: true, controlConflict: false}});
  await withFixture({scan: zero}, async f => {
    const result = await probeCourseVideo(course(), {timeoutMs: 1800});
    assert.equal(result.status, "empty"); assert.equal(result.count, 0);
    assert.ok(f.state.scans >= 3, "empty is observed across multiple settled polls");
  });
  for (const flag of ["busy", "filtered", "notComplete"]) {
    await withFixture({scan: zero, evidence({evidence}) {
      return flag === "notComplete" ? {...evidence, complete: false} : {...evidence, [flag]: true};
    }}, async () => assert.equal((await probeCourseVideo(course(), {timeoutMs: 100})).status, "error"));
  }
});

test("transient zero before cards load is replaced by actual video evidence", async () => {
  await withFixture({scan({scan, round}) {
    return round < 3 ? {...scan, sessions: [], pagination: {confidence: "high", total: 0, complete: true}} : scan;
  }}, async () => assert.equal((await probeCourseVideo(course(), {timeoutMs: 1500})).status, "available"));
});

test("an unresolved second embedded frame prevents the first empty frame from deciding the whole course", async () => {
  await withFixture({
    discover({message}) { return {frames: [3, 4].map(frameId => ({tabId: message.tabId, frameId, origin, path: "/Panopto/Pages/EmbeddedList.aspx"}))}; },
    evidence({evidence, frameId}) { return frameId === 4 ? {...evidence, ready: false} : evidence; },
    scan({scan}) { return {...scan, sessions: [], pagination: {confidence: "high", total: 0, complete: true}}; }
  }, async () => assert.equal((await probeCourseVideo(course(), {timeoutMs: 1100})).status, "error"));
});

test("AbortError interrupts a blocked discovery and releases only the temporary tab", async () => {
  await withFixture({discover() { return new Promise(() => {}); }}, async f => {
    const controller = new AbortController();
    const pending = probeCourseVideo(course(), {signal: controller.signal});
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, {name: "AbortError"});
    assert.deepEqual(f.state.removed, f.state.created);
    await closeProbeTab();
    assert.equal(f.state.removed.length, 1);
    assert.equal(f.onUpdated.count, 0); assert.equal(f.onActivated.count, 0); assert.equal(f.onRemoved.count, 0);
  });
});

test("closing a running probe aborts it; a tab activated by the user is preserved", async () => {
  await withFixture({discover() { return new Promise(() => {}); }}, async f => {
    const pending = probeCourseVideo(course());
    const observed = assert.rejects(pending, {name: "AbortError"});
    await new Promise(resolve => setTimeout(resolve, 10));
    await closeProbeTab(); await observed;
    assert.deepEqual(f.state.removed, f.state.created);
  });
  await withFixture({discover({message, onActivated, tabs}) {
    tabs.get(message.tabId).active = true; onActivated.emit({tabId: message.tabId}); return {frames: []};
  }}, async f => {
    const result = await probeCourseVideo(course());
    assert.equal(result.status, "error"); assert.match(result.message, /已保留/);
    await closeProbeTab(); assert.deepEqual(f.state.removed, []);
  });
});

test("injected evidence reader uses visible errors and loaded media, and pauses media without exporting its URL", async () => {
  await withFixture({}, async f => {
    await probeCourseVideo(course());
    const inspect = f.state.scripts[0];
    const node = value => ({nodeType: 1, parentElement: null, textContent: value, innerText: value, hidden: false,
      closest: () => null, getClientRects: () => [1]});
    let paused = 0;
    const media = {...node(""), readyState: 1, duration: 30, currentSrc: "https://media.invalid/asset?secret=private", pause() { paused++; }, getAttribute() { return null; }};
    const error = node("You do not have permission to access this session.");
    const doc = {readyState: "complete", body: node(""), querySelectorAll(selector) {
      if (selector === "video,audio") return [media];
      if (selector.includes("#errorMessage")) return [error];
      return [];
    }};
    const evidence = vm.runInNewContext(`(${inspect.toString()})()`, {document: doc, location: new URL(viewerUrl),
      performance: {timeOrigin: Date.now()}, getComputedStyle: () => ({display: "block", visibility: "visible"})});
    assert.equal(evidence.error, "ACCESS_DENIED"); assert.equal(evidence.playerReady, true); assert.equal(paused, 1);
    assert.ok(!JSON.stringify(evidence).includes("media.invalid"));
  });
});
