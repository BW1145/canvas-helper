import test from "node:test";
import assert from "node:assert/strict";
import {probeCourseVideo, cancelVideoProbe} from "./course-probe.js";

const folder = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const video = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const origin = "https://school.au.panopto.com";
const list = `${origin}/Panopto/Pages/EmbeddedList.aspx?folderID=${folder}&token=fixture-secret`;
const course = (links = [{url: list}]) => ({id: "1", url: "https://canvas.example/courses/1", panoptoLinks: links, navigationState: "ready"});

async function fixture(steps, run) {
  const previous = {fetch: globalThis.fetch, chrome: globalThis.chrome};
  const calls = [];
  globalThis.chrome = {tabs: new Proxy({}, {get() {throw Error("Background detection must never use tabs");}})};
  globalThis.fetch = async (url, options) => {
    const step = steps[calls.length]; calls.push({url, options});
    assert.ok(step, `Unexpected request: ${url}`);
    assert.equal(options.method, "GET"); assert.equal(options.credentials, "include");
    assert.equal(options.redirect, "manual");
    if (step.pending) return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {once: true}));
    const status = step.status ?? 200;
    return {status, ok: status >= 200 && status < 300, type: step.type || "basic", url: step.url || url,
      headers: {get: () => step.html ? "text/html" : "application/json"},
      text: async () => step.html || JSON.stringify(step.data)};
  };
  try {await run(calls);} finally {await cancelVideoProbe(); Object.assign(globalThis, previous);}
}

test("background folder checks confirm videos without creating or changing tabs", async () => {
  await fixture([{data: {Results: [{Id: video, Folder: folder, Status: "Complete"}]}}], async calls => {
    const result = await probeCourseVideo(course());
    assert.equal(result.status, "available"); assert.equal(result.count, null);
    assert.equal(calls[0].url, `${origin}/Panopto/api/v1/folders/${folder}/sessions?pageNumber=0`);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|token=/);
  });
});

test("only a valid successful empty folder response means no videos", async () => {
  await fixture([{data: {Results: []}}], async () => assert.equal((await probeCourseVideo(course())).status, "empty"));
  for (const data of [{}, {Results: null}, {Results: [{Id: video, Folder: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}]}, {Results: [{Id: "bad", Folder: folder}]}]) {
    await fixture([{data}], async () => assert.notEqual((await probeCourseVideo(course())).status, "empty"));
  }
});

test("login, denied APIs and login HTML keep the discovered entrance without claiming empty or missing videos", async () => {
  for (const step of [{status: 401}, {status: 403}, {status: 302}, {html: "<html>Sign in</html>"}]) {
    await fixture([step], async () => {
      const result = await probeCourseVideo(course());
      assert.equal(result.status, "linked"); assert.ok(result.url); assert.match(result.message, /打开/);
      assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    });
  }
});

test("Canvas launches resolve through the source session and never execute or navigate the tool page", async () => {
  await fixture([{data: {Results: [{Id: video, Folder: folder}]}}], async () => {
    let resolved = false;
    const result = await probeCourseVideo(course([{url: "https://canvas.example/courses/1/external_tools/42"}]), {
      async resolveTool(url) {resolved = true; assert.match(url, /courses\/1\/external_tools\/42$/); return {links: [{url: list}]};}
    });
    assert.equal(resolved, true); assert.equal(result.status, "available");
    assert.equal(result.url, "https://canvas.example/courses/1/external_tools/42");
  });
});

test("an LTI page requiring interactive launch remains an entrance, not a video-read failure", async () => {
  await fixture([], async calls => {
    const result = await probeCourseVideo(course([{url: "https://canvas.example/courses/1/external_tools/42"}]), {resolveTool: async () => ({links: []})});
    assert.equal(result.status, "linked"); assert.equal(calls.length, 0);
  });
});

test("single-session URLs require matching server evidence", async () => {
  const target = course([{url: `${origin}/Panopto/Pages/Viewer.aspx?id=${video}`}]);
  await fixture([{data: {Id: video, Status: "Complete"}}], async () => assert.equal((await probeCourseVideo(target)).status, "available"));
  await fixture([{data: {Id: folder, Status: "Complete"}}], async () => assert.equal((await probeCourseVideo(target)).status, "linked"));
});

test("an empty folder does not decide a course containing another unresolved entrance", async () => {
  const target = course([{url: list}, {url: "https://canvas.example/courses/1/external_tools/42"}]);
  await fixture([{data: {Results: []}}], async () => assert.equal((await probeCourseVideo(target, {resolveTool: async () => ({links: []})})).status, "linked"));
});

test("missing navigation and unreadable navigation stay distinct without network or tabs", async () => {
  await fixture([], async () => {
    assert.equal((await probeCourseVideo(course([]))).status, "not_found");
    assert.equal((await probeCourseVideo({...course([]), navigationState: "error"})).status, "error");
    for (const url of ["javascript:alert(1)", "https://canvas.example/courses/2/external_tools/42", "https://school.panopto.com.evil.invalid/Panopto/Pages/Viewer.aspx?id=" + video]) {
      assert.equal((await probeCourseVideo(course([{url}]))).status, "error");
    }
  });
});

test("stop cancels a pending background response", async () => {
  await fixture([{pending: true}], async calls => {
    const controller = new AbortController();
    const task = probeCourseVideo(course(), {signal: controller.signal});
    while (!calls.length) await new Promise(resolve => setImmediate(resolve));
    controller.abort(); await assert.rejects(task, {name: "AbortError"});
    assert.equal(calls[0].options.signal.aborted, true);
  });
});

test("a timeout preserves the known entrance and releases the request", async () => {
  await fixture([{pending: true}], async calls => {
    assert.equal((await probeCourseVideo(course(), {timeoutMs: 20})).status, "linked");
    assert.equal(calls[0].options.signal.aborted, true);
  });
});

test("rate limiting pauses detection with a distinct reason", async () => {
  await fixture([{status: 429}], async () => assert.equal((await probeCourseVideo(course())).code, "RATE_LIMIT"));
});
