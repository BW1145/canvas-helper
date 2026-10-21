"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = readFileSync(path.join(__dirname, "canvas-client.js"), "utf8");
const ORIGIN = "https://canvas.example.invalid";
const CATALOG = "/api/v1/courses";
const FRONT = "/api/v1/courses/12/front_page";
const TABS = "/api/v1/courses/12/tabs";
const SESSION = "11111111-2222-4333-8444-555555555555";
const FOLDER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = Date.parse("2026-10-21T06:00:00Z");
const serial = (value) => JSON.parse(JSON.stringify(value));
const decode = (text) => String(text).replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (value) => {
  const named = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": "\u00a0"};
  if (named[value.toLowerCase()] !== undefined) return named[value.toLowerCase()];
  return String.fromCodePoint(parseInt(value.slice(value[2]?.toLowerCase() === "x" ? 3 : 2, -1), value[2]?.toLowerCase() === "x" ? 16 : 10));
});

// A small inert DOM fixture supplies only the browser boundary the client uses.
// Production parsing remains the browser's DOMParser, never this fixture parser.
class Element {
  constructor(tagName, attributes = {}) {
    this.nodeType = 1; this.tagName = tagName.toUpperCase(); this.attributes = attributes;
    this.childNodes = []; this.parentElement = null;
  }
  getAttribute(name) { return this.attributes[name.toLowerCase()] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name.toLowerCase()); }
  append(node) { node.parentElement = this; this.childNodes.push(node); }
  get textContent() { return this.childNodes.map((node) => node.nodeType === 3 ? node.nodeValue : node.textContent).join(""); }
}
class FixtureDOMParser {
  parseFromString(html, kind) {
    assert.equal(kind, "text/html");
    const body = new Element("body"), stack = [body];
    for (const token of String(html).match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g) || []) {
      if (token.startsWith("<!--")) continue;
      if (token.startsWith("</")) {
        const name = token.match(/^<\/([\w-]+)/)?.[1].toUpperCase();
        const index = stack.map((node) => node.tagName).lastIndexOf(name);
        if (index > 0) stack.length = index;
      } else if (token.startsWith("<")) {
        const name = token.match(/^<([\w-]+)/)?.[1];
        if (!name) continue;
        const attributes = {};
        const rest = token.slice(name.length + 1, token.endsWith("/>") ? -2 : -1);
        for (const match of rest.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attributes[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? "");
        const node = new Element(name, attributes); stack.at(-1).append(node);
        if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(name) && !token.endsWith("/>")) stack.push(node);
      } else stack.at(-1).append({nodeType: 3, nodeValue: decode(token)});
    }
    return {body, querySelectorAll(selector) {
      assert.equal(selector, "a[href],iframe[src]");
      const found = [];
      function walk(node) {
        if (node.nodeType !== 1) return;
        if ((node.tagName === "A" && node.hasAttribute("href")) || (node.tagName === "IFRAME" && node.hasAttribute("src"))) found.push(node);
        node.childNodes.forEach(walk);
      }
      walk(body); return found;
    }};
  }
}

function course(extra = {}) {
  return {id: 12, name: "Music and listening", course_code: "MUS125", workflow_state: "available", default_view: "wiki",
    term: {id: 20262, name: "2026 Semester Two", start_at: "2026-07-20T00:00:00+12:00", end_at: "2026-11-30T00:00:00+13:00"},
    syllabus_body: "", ...extra};
}
function harness({steps, dashboard = [], url = ORIGIN + "/", expireTimer = false, activeCourses} = {}) {
  const calls = [], activeCalls = [], errors = [], timers = new Set();
  class FrozenDate extends Date { static now() { return NOW; } }
  const context = {
    URL, URLSearchParams, AbortController, DOMException, Date: FrozenDate, DOMParser: FixtureDOMParser,
    location: new URL(url),
    document: {querySelectorAll(selector) {
      assert.match(selector, /DashboardCard/);
      return dashboard.map((href) => ({getAttribute: name => name === "href" ? href : null}));
    }},
    setTimeout(callback, ms) { const timer = setTimeout(callback, expireTimer ? 0 : ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    async fetch(value, options) {
      const target = new URL(value), index = calls.length;
      if (target.pathname === CATALOG && target.searchParams.get("enrollment_state") === "active") {
        activeCalls.push({url: target, options});
        const data = activeCourses ?? steps.flatMap(step => Array.isArray(step.json) ? step.json.filter(item => item?.course_code) : []);
        return {status: 200, ok: true, url: target.href, headers: {get: () => null}, text: async () => JSON.stringify(data)};
      }
      const step = steps?.[index];
      calls.push({url: target, options});
      try {
        assert.ok(step, `Unexpected request ${index + 1}: ${target.pathname}`);
        assert.equal(target.origin, ORIGIN);
        assert.equal(options.method, "GET");
        assert.equal(options.credentials, "include");
        assert.equal(options.redirect, "manual", "do not forward reads into an external login redirect");
        assert.equal(options.headers.Accept, target.pathname.startsWith("/api/") ? "application/json+canvas-string-ids" : "text/html");
        if (step.path) assert.equal(target.pathname, step.path);
        step.check?.({url: target, options});
      } catch (cause) { errors.push(cause); throw cause; }
      if (step.abort) return new Promise((resolve, reject) => {
        const stop = () => reject(new DOMException("aborted", "AbortError"));
        if (options.signal.aborted) stop(); else options.signal.addEventListener("abort", stop, {once: true});
      });
      if (step.throw) throw step.throw;
      const status = step.status ?? 200;
      return {status, ok: status >= 200 && status < 300, type: step.type || "basic", url: step.finalUrl || target.href,
        headers: {get(name) { return ({"content-type": step.contentType || (step.json !== undefined ? "application/json" : "text/plain"), link: step.link || ""})[name.toLowerCase()] ?? null; }},
        text: async () => step.json !== undefined ? JSON.stringify(step.json) : String(step.text ?? "")};
    }
  };
  vm.createContext(context); vm.runInContext(source, context, {filename: "canvas-client.js"});
  return {client: context.CanvasOverviewClient, calls, activeCalls, context,
    finish(count = steps?.length ?? 0) { assert.deepEqual(errors, []); assert.equal(calls.length, count); assert.equal(timers.size, 0); }};
}

test("catalog follows every page, uses explicit dates, and keeps upcoming terms available", async () => {
  const h = harness({dashboard: ["/courses/40"], steps: [
    {path: CATALOG, json: [course(), course({id: 40, term: {id: 20261, name: "Old", start_at: "2026-01-01", end_at: "2026-06-30"}})],
      link: `<${ORIGIN}/api/v1/courses?enrollment_type=student&include%5B%5D=term&include%5B%5D=syllabus_body&per_page=100&page=2>; rel="next"`,
      check({url}) { assert.equal(url.searchParams.get("enrollment_type"), "student"); assert.equal(url.searchParams.has("enrollment_state"), false); assert.deepEqual(url.searchParams.getAll("include[]"), ["term", "syllabus_body"]); }},
    {path: CATALOG, json: [course({id: 41, name: "Next year", syllabus_body: "<p>cached original content</p>", term: {id: 20271, name: "Next", start_at: "2027-02-01", end_at: "2027-06-30"}}),
      course({id: 42, term: {id: 2026, name: "Full year", start_at: "2026-02-01", end_at: "2026-12-01"}}),
      course({id: 12, name: "duplicate"}), course({id: 44, restrict_enrollments_to_course_dates: true, start_at: "2027-01-01", end_at: "2027-02-01"})]}
  ]});
  const result = serial(await h.client.getCatalog());
  assert.equal(result.ok, true); assert.equal(result.defaultScope, "current");
  assert.equal(result.notice, "", "dated past and future courses are not reported as missing dates");
  assert.deepEqual(result.currentIds, ["12", "42"]); assert.deepEqual(result.dashboardIds, ["40"]);
  assert.equal(result.courses.length, 5); assert.equal(result.courses[0].name, "Music and listening");
  assert.ok(result.terms.some((term) => term.key === "term:20271"));
  assert.equal(JSON.stringify(result).includes("cached original content"), false, "raw syllabus stays inside the page-side cache");
  h.finish();
});

test("missing dates use only known Dashboard cards and never guess from semester names", async () => {
  const h = harness({dashboard: ["/courses/12", "/courses/12/assignments", "/courses/99", "https://elsewhere.invalid/courses/13"], steps: [
    {json: [course({term: {id: 5, name: "Current Semester 2026"}}), course({id: 13, term: {id: 6, name: "Term Two", start_at: "2019-01-01", end_at: null}})]}
  ]});
  const result = serial(await h.client.getCatalog());
  assert.deepEqual(result.currentIds, []); assert.deepEqual(result.dashboardIds, ["12"]);
  assert.equal(result.defaultScope, "dashboard"); assert.match(result.notice, /日期/);
  h.finish();
});

test("server-computed active enrollments exclude past courses despite overlapping public term dates", async () => {
  const h = harness({activeCourses: [{id: 12}, {id: 14}, {id: 15}], steps: [{json: [
    course(), course({id: 13, name: "Past course with broad term dates"}),
    course({id: 14, workflow_state: "completed"}), course({id: 15, access_restricted_by_date: true})
  ]}]});
  const result = serial(await h.client.getCatalog());
  assert.deepEqual(result.currentIds, ["12"]);
  assert.equal(result.courses.length, 4, "past courses remain available through their explicit semester");
  assert.equal(h.activeCalls.length, 1);
  assert.equal(h.activeCalls[0].url.searchParams.get("enrollment_type"), "student");
  assert.equal(h.activeCalls[0].url.searchParams.get("enrollment_state"), "active");
  h.finish();
});

test("completed enrollment overrides use the clearly labeled Dashboard fallback", async () => {
  const h = harness({activeCourses: [], dashboard: ["/courses/12"], steps: [{json: [course()]}]});
  const result = serial(await h.client.getCatalog());
  assert.deepEqual(result.currentIds, []); assert.equal(result.defaultScope, "dashboard");
  h.finish();
});

test("a discovered course tool is read as inert HTML and exposes only real Panopto links", async () => {
  const tool = `${ORIGIN}/courses/12/external_tools/98`;
  const h = harness({steps: [
    {json: [course()]}, {path: FRONT, status: 404}, {path: TABS, json: [{label: "Panopto Video", html_url: tool}]},
    {path: "/courses/12/external_tools/98", contentType: "text/html", text: `<script>window.open('https://unrelated.invalid')</script><iframe src="https://school.panopto.com/Panopto/Pages/EmbeddedList.aspx?folderID=${FOLDER}"></iframe>`}
  ]});
  await h.client.getCatalog(); await h.client.getCourse("12");
  assert.equal((await h.client.getVideoLinks("13", tool)).ok, false);
  assert.equal((await h.client.getVideoLinks("12", tool + "?invented=true")).ok, false);
  const result = await h.client.getVideoLinks("12", tool);
  assert.equal(result.ok, true); assert.equal(result.links.length, 1);
  assert.equal(result.links[0].kind, "folder"); h.finish();
});

test("launch pages requiring a form or redirect return an entrance for the user to open", async () => {
  for (const step of [{status: 0, type: "opaqueredirect"}, {status: 401}, {contentType: "text/html", text: '<form action="https://school.panopto.com/Panopto/LTI/LTI.aspx" method="post"><input name="oauth_signature" value="fixture-secret"></form>'}]) {
    const tool = `${ORIGIN}/courses/12/external_tools/98`;
    const h = harness({steps: [{json: [course()]}, {path: FRONT, status: 404}, {path: TABS, json: [{label: "Panopto", html_url: tool}]}, {...step, path: "/courses/12/external_tools/98"}]});
    await h.client.getCatalog(); await h.client.getCourse("12");
    const result = await h.client.getVideoLinks("12", tool);
    assert.equal(result.ok, true); assert.deepEqual(serial(result.links), []);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/); h.finish();
  }
});

test("a mixed current and undated catalog explains why undated courses are outside the default scope", async () => {
  const h = harness({dashboard: ["/courses/12", "/courses/13"], steps: [
    {json: [course(), course({id: 13, term: {id: 8, name: "Undated term"}}),
      course({id: 14, term: {id: 9, name: "Future term", start_at: "2027-02-01", end_at: "2027-06-30"}})]}
  ]});
  const result = serial(await h.client.getCatalog());
  assert.equal(result.defaultScope, "current"); assert.deepEqual(result.currentIds, ["12"]);
  assert.deepEqual(result.dashboardIds, ["12", "13"]);
  assert.equal(result.notice, "部分课程缺少日期，未计入当前学期；可切换学期或查看 Dashboard 上的课程。");
  assert.equal(result.courses.length, 3, "all accessible courses remain available in the other scopes");
  h.finish();
});

test("64-bit string course and term IDs survive catalog, Dashboard matching and course reads exactly", async () => {
  const id = "9007199254740993", termId = "9223372036854775806";
  const h = harness({dashboard: [`/courses/${id}`], steps: [
    {json: [course({id, default_view: "syllabus", syllabus_body: "<p>Large ID course</p>", term: {id: termId, name: "Future term"}})]},
    {path: `/api/v1/courses/${id}/tabs`, json: [{label: "Panopto Video", html_url: `/courses/${id}/external_tools/21`}]}
  ]});
  const catalog = serial(await h.client.getCatalog());
  assert.equal(catalog.ok, true); assert.equal(catalog.courses[0].id, id);
  assert.equal(catalog.courses[0].termKey, `term:${termId}`); assert.deepEqual(catalog.dashboardIds, [id]);
  const detail = await h.client.getCourse(id);
  assert.equal(detail.ok, true); assert.equal(detail.id, id);
  assert.equal(detail.intro.url, `${ORIGIN}/courses/${id}/assignments/syllabus`);
  assert.equal(detail.panoptoLinks[0].url, `${ORIGIN}/courses/${id}/external_tools/21`);
  h.finish();
});

test("unsafe numeric IDs are rejected before rounded course paths or term groups can be used", async () => {
  for (const entry of [course({id: Number("9007199254740993")}), course({term: {id: Number("9223372036854775806")}})]) {
    const h = harness({steps: [{json: [entry]}]});
    const result = await h.client.getCatalog();
    assert.equal(result.ok, false); assert.equal(result.code, "INVALID_ID");
    assert.equal((await h.client.getCourse(Number("9007199254740993"))).code, "INVALID_ID");
    h.finish();
  }
});

test("complete course dates supply an undated term; completely undated lists ask for a term", async () => {
  const h = harness({steps: [{json: [course({term: null, enrollment_term_id: 88, start_at: "2026-09-01", end_at: "2026-12-01"})]}]});
  const result = serial(await h.client.getCatalog());
  assert.deepEqual(result.currentIds, ["12"]); assert.equal(result.courses[0].termKey, "term:88"); h.finish();
  const empty = harness({steps: [{json: [course({term: null})]}]});
  const undated = serial(await empty.client.getCatalog());
  assert.equal(undated.defaultScope, "all"); assert.match(undated.notice, /选择学期/); empty.finish();
});

test("pagination rejects foreign hosts, other API routes, token parameters, loops and malformed next links", async () => {
  const variants = [
    [`<https://outside.invalid/api/v1/courses?page=2>; rel="next"`, "BAD_TARGET"],
    [`<${ORIGIN}/api/v1/users?page=2>; rel="next"`, "BAD_TARGET"],
    [`<${ORIGIN}/api/v1/courses?page=2&access_token=secret>; rel="next"`, "BAD_TARGET"],
    [`<${ORIGIN}/api/v1/courses?per_page=100&enrollment_type=student&include%5B%5D=term&include%5B%5D=syllabus_body>; rel="next"`, "INCOMPLETE_LIST"],
    [`nonsense; rel="next"`, "INVALID_PAGINATION"]
  ];
  for (const [link, code] of variants) {
    const h = harness({steps: [{json: [course()], link}]});
    const result = await h.client.getCatalog(); assert.equal(result.ok, false); assert.equal(result.code, code); h.finish();
  }
});

test("a failed later page does not present or cache a partial course list", async () => {
  const h = harness({steps: [{json: [course()], link: `</api/v1/courses?page=2>; rel="next"`}, {status: 500}]});
  const result = await h.client.getCatalog(); assert.equal(result.ok, false); assert.equal(result.code, "HTTP_ERROR");
  assert.equal((await h.client.getCourse("12")).code, "COURSE_NOT_LISTED"); h.finish();
});

test("wiki introduction keeps original readable text, removes hidden/script content, and finds only valid entrances", async () => {
  const h = harness({steps: [
    {json: [course()]},
    {path: FRONT, json: {published: true, body: `<h1>Welcome &amp; listen</h1><p>Learn <strong>harmony</strong> together.</p><ul><li>Analysis</li><li>Writing</li></ul><script>secretScript()</script><nav>Navigation noise</nav><div hidden>Hidden secret</div><div style="display: none !important"><p>Invisible</p></div><p aria-hidden="true">Also hidden</p><iframe src="https://school.panopto.com/Panopto/Pages/Embed.aspx?id=${SESSION}&amp;auth=private" title="Lecture"></iframe>`,
      html_url: `${ORIGIN}/courses/12/pages/welcome?auth=private#t=1`}},
    {path: TABS, json: [
      {label: "Panopto Video", html_url: "/courses/12/external_tools/98?token=private"},
      {label: "Panopto other course", html_url: "/courses/13/external_tools/98"},
      {label: "Panopto hidden", html_url: "/courses/12/external_tools/99", hidden: true},
      {label: "Panopto admin", html_url: "/courses/12/external_tools/100", visibility: "admins"},
      {label: "Panopto evil", html_url: `https://school.panopto.com.evil.invalid/Panopto/Pages/Viewer.aspx?id=${SESSION}`}
    ]}
  ]});
  assert.equal((await h.client.getCatalog()).ok, true);
  const result = serial(await h.client.getCourse("12"));
  assert.equal(result.intro.text, "Welcome & listen\n\nLearn harmony together.\n\n• Analysis\n\n• Writing");
  assert.equal(result.intro.sourceLabel, "课程首页");
  assert.equal(result.intro.url, `${ORIGIN}/courses/12/pages/welcome`);
  assert.equal(result.navigationState, "ready");
  assert.deepEqual(result.panoptoLinks.map((x) => [x.kind, x.url]), [
    ["tool", `${ORIGIN}/courses/12/external_tools/98?token=private`],
    ["video", `https://school.panopto.com/Panopto/Pages/Embed.aspx?id=${SESSION}&auth=private`]
  ]);
  assert.doesNotMatch(JSON.stringify(result.intro), /private|secret|Invisible|Navigation noise/); h.finish();
});

test("a missing front page falls back to syllabus and extracts a real folder link", async () => {
  const h = harness({steps: [
    {json: [course({syllabus_body: `<p>Four-part writing.</p><iframe src="https://school.panopto.eu/Panopto/Pages/EmbeddedList.aspx?folderID=${FOLDER}&amp;token=private"></iframe>`})]},
    {path: FRONT, status: 404},
    {path: TABS, json: [{label: "Lecture Recordings", html_url: "/courses/12/external_tools/12"}]}
  ]});
  await h.client.getCatalog(); const result = serial(await h.client.getCourse(12));
  assert.equal(result.intro.text, "Four-part writing."); assert.equal(result.intro.sourceLabel, "课程大纲");
  assert.equal(result.intro.url, `${ORIGIN}/courses/12/assignments/syllabus`);
  const folder = new URL(result.panoptoLinks.find((link) => link.kind === "folder").url);
  assert.equal(folder.pathname, "/Panopto/Pages/EmbeddedList.aspx");
  assert.equal(folder.searchParams.get("folderID"), FOLDER);
  assert.equal(folder.searchParams.get("token"), "private", "preserve the actual in-memory launch URL"); h.finish();
});

test("a syllabus homepage uses the syllabus directly without requesting an unrelated front page", async () => {
  const h = harness({steps: [{json: [course({default_view: "syllabus", syllabus_body: "<p>One &amp; two.</p><p>Next paragraph.</p>"})]}, {path: TABS, json: []}]});
  await h.client.getCatalog(); const result = await h.client.getCourse(12);
  assert.equal(result.intro.state, "ready"); assert.equal(result.intro.text, "One & two.\n\nNext paragraph."); h.finish();
});

test("an empty module homepage has an empty introduction, not an invented summary", async () => {
  const h = harness({steps: [{json: [course({default_view: "modules"})]}, {path: FRONT, status: 404}, {path: TABS, json: [{label: "Modules", html_url: "/courses/12/modules"}]}]});
  await h.client.getCatalog(); const result = await h.client.getCourse(12);
  assert.equal(result.ok, true); assert.equal(result.intro.state, "empty"); assert.equal(result.intro.text, "");
  assert.equal(result.navigationState, "ready"); assert.equal(result.panoptoLinks.length, 0); h.finish();
});

test("individual access failures remain explicit introduction/navigation errors", async () => {
  const h = harness({steps: [{json: [course()]}, {path: FRONT, status: 403}, {path: TABS, status: 403}]});
  await h.client.getCatalog(); const result = await h.client.getCourse(12);
  assert.equal(result.ok, true); assert.equal(result.intro.state, "error"); assert.equal(result.navigationState, "error");
  assert.match(result.message, /无法读取/); assert.equal(result.panoptoLinks.length, 0); h.finish();
});

test("accessible cached syllabus remains useful when only the front page is denied", async () => {
  const h = harness({steps: [{json: [course({syllabus_body: "<p>Available course description</p>"})]}, {path: FRONT, status: 403}, {path: TABS, json: []}]});
  await h.client.getCatalog(); const result = await h.client.getCourse(12);
  assert.equal(result.intro.state, "ready"); assert.equal(result.intro.text, "Available course description");
  assert.match(result.intro.message, /首页/); h.finish();
});

test("locked page bodies and their embedded links are not exposed", async () => {
  const h = harness({steps: [{json: [course()]}, {path: FRONT, json: {locked_for_user: true, body: `<p>restricted secret</p><iframe src="https://school.panopto.com/Panopto/Pages/Embed.aspx?id=${SESSION}"></iframe>`}}, {path: TABS, json: []}]});
  await h.client.getCatalog(); const result = await h.client.getCourse(12);
  assert.equal(result.intro.state, "error"); assert.equal(result.panoptoLinks.length, 0); assert.doesNotMatch(JSON.stringify(result), /restricted secret/); h.finish();
});

test("authentication and throttling are global pause errors instead of missing courses", async () => {
  const variants = [
    [{status: 401}, "AUTH_REQUIRED"], [{status: 403}, "ACCESS_DENIED"], [{status: 429}, "RATE_LIMIT"],
    [{status: 0, type: "opaqueredirect"}, "AUTH_REQUIRED"],
    [{contentType: "text/html", text: "<html>Sign in</html>"}, "AUTH_REQUIRED"],
    [{json: [], finalUrl: "https://login.example.invalid/sso"}, "AUTH_REQUIRED"]
  ];
  for (const [step, code] of variants) {
    const h = harness({steps: [step]}); const result = await h.client.getCatalog();
    assert.equal(result.ok, false); assert.equal(result.code, code); h.finish();
  }
  const h = harness({steps: [{json: [course()]}, {path: FRONT, status: 401}, {path: TABS, json: []}]});
  await h.client.getCatalog(); assert.equal((await h.client.getCourse(12)).code, "AUTH_REQUIRED"); h.finish();
});

test("invalid API responses and network failures cannot become empty successful catalogs", async () => {
  const variants = [[{text: "not JSON"}, "INVALID_RESPONSE"], [{json: {errors: ["error"]}}, "INVALID_RESPONSE"], [{throw: new Error("private request URL")}, "NETWORK_ERROR"]];
  for (const [step, code] of variants) {
    const h = harness({steps: [step]}); const result = await h.client.getCatalog();
    assert.equal(result.ok, false); assert.equal(result.code, code); assert.doesNotMatch(result.message, /private request URL/); h.finish();
  }
});

test("timeouts use the public TIMEOUT code rather than DOMException's numeric code", async () => {
  const h = harness({expireTimer: true, steps: [{abort: true}]});
  assert.equal((await h.client.getCatalog()).code, "TIMEOUT"); h.finish();
});

test("reinjection keeps the same client and authorized catalog; invalid course IDs do no reads", async () => {
  const h = harness({steps: [{json: [course({default_view: "syllabus", syllabus_body: "<p>Cached intro</p>"})]}, {path: TABS, json: []}]});
  await h.client.getCatalog(); const prior = h.context.CanvasOverviewClient;
  vm.runInContext(source, h.context); assert.equal(h.context.CanvasOverviewClient, prior);
  assert.equal((await h.client.getCourse("12/../13")).code, "COURSE_NOT_LISTED");
  assert.equal((await h.client.getCourse("99")).code, "COURSE_NOT_LISTED");
  assert.equal((await h.client.getCourse("12")).intro.text, "Cached intro"); h.finish();
  const insecure = harness({url: "http://canvas.example.invalid/", steps: []});
  assert.equal((await insecure.client.getCatalog()).code, "BAD_SOURCE"); insecure.finish();
});
