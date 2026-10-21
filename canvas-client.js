(() => {
  "use strict";
  const VERSION = "0.5.0";
  if (globalThis.CanvasOverviewClient?.version === VERSION) return;

  // This client runs in the isolated world of the Canvas tab granted activeTab.
  // It uses that page's session and never sends requests to another origin.
  const coursesById = new Map();
  const toolsByCourse = new Map();
  const ID = /^[1-9]\d*$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_PAGES = 50;
  const MAX_ITEMS = 3000;
  const fail = (code, message) => Object.assign(new Error(message), {code, canvasOverviewError: true});
  const resultError = (cause) => ({ok: false,
    code: cause?.canvasOverviewError ? cause.code : "CANVAS_ERROR",
    message: cause?.canvasOverviewError ? cause.message : "未能读取 Canvas 课程信息，请重试。"});
  const clean = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const time = (value) => typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const idText = (value) => {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw fail("INVALID_ID", "Canvas 返回了无法准确读取的编号，本次课程读取已停止。");
    return String(value);
  };

  function canvasOrigin() {
    const url = new URL(location.href);
    if (url.protocol !== "https:" || url.username || url.password) throw fail("BAD_SOURCE", "请从已登录的 HTTPS Canvas Dashboard 打开课程总览。");
    return url.origin;
  }

  function apiUrl(value, path, allowedParams) {
    let target;
    try { target = new URL(value, canvasOrigin()); } catch { throw fail("BAD_TARGET", "Canvas 返回了无效的课程分页地址。"); }
    if (target.origin !== canvasOrigin() || target.protocol !== "https:" || target.username || target.password ||
        target.pathname !== path || !path.startsWith("/api/v1/") || target.hash ||
        [...target.searchParams.keys()].some((key) => !allowedParams.has(key))) {
      throw fail("BAD_TARGET", "Canvas 返回了课程范围以外的分页地址，已停止读取。");
    }
    return target;
  }

  async function request(value, path, allowedParams = new Set()) {
    const target = apiUrl(value, path, allowedParams);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await globalThis.fetch(target.href, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "manual",
        headers: {Accept: "application/json+canvas-string-ids"}, signal: controller.signal
      });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) || response.status === 401) {
        throw fail("AUTH_REQUIRED", "Canvas 需要重新登录。请回到 Dashboard 完成登录，再点击“刷新”。");
      }
      if (response.status === 403) throw fail("ACCESS_DENIED", "当前账户无法读取这部分课程内容。");
      if (response.status === 404) throw fail("NOT_FOUND", "课程尚未提供这个页面。");
      if (response.status === 429) throw fail("RATE_LIMIT", "Canvas 要求放慢请求，请稍后点击“刷新”继续。");
      if (!response.ok) throw fail("HTTP_ERROR", `Canvas 请求未完成（HTTP ${response.status}）。`);
      const finalUrl = new URL(response.url || target.href, target.href);
      if (finalUrl.origin !== target.origin || finalUrl.pathname !== path) throw fail("AUTH_REQUIRED", "Canvas 返回了登录或跳转页面，请回到 Dashboard 确认登录后重试。");
      const body = await response.text();
      if (body.length > 8 * 1024 * 1024) throw fail("RESPONSE_TOO_LARGE", "Canvas 单次返回的课程内容过大，请稍后重试。");
      if (/text\/html/i.test(response.headers.get("content-type") || "") || /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(body)) {
        throw fail("AUTH_REQUIRED", "Canvas 返回了网页而非课程数据，请回到 Dashboard 确认登录后重试。");
      }
      let data;
      try { data = JSON.parse(body); } catch { throw fail("INVALID_RESPONSE", "Canvas 返回了无法识别的课程数据。"); }
      return {data, link: response.headers.get("link") || ""};
    } catch (cause) {
      if (cause?.canvasOverviewError) throw cause;
      if (cause?.name === "AbortError") throw fail("TIMEOUT", "Canvas 课程请求超过 20 秒，请重试。");
      throw fail("NETWORK_ERROR", "未能连接 Canvas，请检查课程页后重试。");
    } finally { clearTimeout(timer); }
  }

  function nextLink(header) {
    // Canvas's Link entries use angle-bracket targets; URLs themselves may
    // contain commas, so splitting the entire header on commas is unsafe.
    const links = [...String(header).matchAll(/<([^>]*)>\s*((?:;\s*[^,]*)*)/g)];
    for (const [, url, attributes] of links) {
      const relation = attributes.match(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i);
      if ((relation?.[1] || relation?.[2] || "").split(/\s+/).includes("next")) return url;
    }
    if (/\brel\s*=\s*["']?next\b/i.test(header)) throw fail("INVALID_PAGINATION", "Canvas 的下一页信息不完整，请重新扫描课程。");
    return null;
  }

  async function list(path, params = {}) {
    const initial = new URL(path, canvasOrigin());
    initial.searchParams.set("per_page", "100");
    for (const [key, values] of Object.entries(params)) for (const value of Array.isArray(values) ? values : [values]) initial.searchParams.append(key, value);
    const allowed = new Set([...initial.searchParams.keys(), "page"]);
    const visited = new Set();
    const output = [];
    let current = initial.href;
    while (current) {
      const target = apiUrl(current, path, allowed).href;
      if (visited.has(target) || visited.size >= MAX_PAGES) throw fail("INCOMPLETE_LIST", "Canvas 课程分页未能完整读取，请重新扫描。");
      visited.add(target);
      const {data, link} = await request(target, path, allowed);
      if (!Array.isArray(data)) throw fail("INVALID_RESPONSE", "Canvas 未返回有效的课程列表。");
      output.push(...data);
      if (output.length > MAX_ITEMS) throw fail("INCOMPLETE_LIST", "课程列表超过本次读取范围，请稍后重试。");
      const next = nextLink(link);
      current = next ? new URL(next, target).href : null;
    }
    return output;
  }

  function normalizeCourse(raw) {
    if (!raw || raw.workflow_state === "deleted") return null;
    const id = idText(raw.id);
    if (!ID.test(id)) return null;
    const termId = idText(raw.term?.id ?? raw.enrollment_term_id);
    const termKey = ID.test(termId) ? `term:${termId}` : "undated";
    return {id, name: clean(raw.original_name || raw.name) || `课程 ${id}`,
      code: clean(raw.course_code), url: `${canvasOrigin()}/courses/${id}`,
      termKey, termName: clean(raw.term?.name) || (termKey === "undated" ? "未注明学期" : `学期 ${termId}`),
      termStart: time(raw.term?.start_at) === null ? null : raw.term.start_at,
      termEnd: time(raw.term?.end_at) === null ? null : raw.term.end_at,
      startAt: time(raw.start_at) === null ? null : raw.start_at,
      endAt: time(raw.end_at) === null ? null : raw.end_at,
      defaultView: clean(raw.default_view) || "modules"};
  }

  function courseDates(raw) {
    let start = time(raw.term?.start_at), end = time(raw.term?.end_at);
    const ownStart = time(raw.start_at), ownEnd = time(raw.end_at);
    if (raw.restrict_enrollments_to_course_dates === true || start === null || end === null) {
      start = ownStart; end = ownEnd;
    }
    // A lone old start date with no end would include every historical course.
    // Treat incomplete date ranges as unknown rather than infer a semester.
    return start === null || end === null || start >= end ? null : {start, end};
  }

  function currentCourse(raw, now) {
    if (raw.workflow_state === "completed" || raw.access_restricted_by_date === true) return false;
    const dates = courseDates(raw);
    return dates !== null && dates.start <= now && now < dates.end;
  }

  function dashboardCourseIds(known) {
    const ids = new Set();
    const links = document.querySelectorAll('.ic-DashboardCard a[href], #DashboardCard_Container a[href], [data-testid="dashboard-card"] a[href]');
    for (const link of links) {
      let url;
      try { url = new URL(link.getAttribute("href"), location.href); } catch { continue; }
      const match = url.pathname.match(/^\/courses\/([1-9]\d*)(?:\/|$)/);
      if (url.origin === canvasOrigin() && match && known.has(match[1])) ids.add(match[1]);
    }
    return [...ids];
  }

  async function getCatalog() {
    try {
      const rawCourses = await list("/api/v1/courses", {enrollment_type: "student", "include[]": ["term", "syllabus_body"]});
      const nextCache = new Map();
      const courses = [];
      for (const raw of rawCourses) {
        const course = normalizeCourse(raw);
        if (!course || nextCache.has(course.id)) continue;
        nextCache.set(course.id, raw); courses.push(course);
      }
      const termsByKey = new Map();
      for (const course of courses) if (!termsByKey.has(course.termKey)) termsByKey.set(course.termKey, {key: course.termKey, name: course.termName});
      // Canvas computes active enrollments using student/section date overrides;
      // the public term range alone can include courses that have already ended.
      const activeCourses = await list("/api/v1/courses", {enrollment_type: "student", enrollment_state: "active"});
      const activeIds = new Set(activeCourses.map(raw => idText(raw.id)));
      const currentIds = courses.filter((course) => activeIds.has(course.id) && currentCourse(nextCache.get(course.id), Date.now())).map((course) => course.id);
      const dashboardIds = dashboardCourseIds(nextCache);
      const defaultScope = currentIds.length ? "current" : dashboardIds.length ? "dashboard" : "all";
      const unknownDates = courses.some((course) => courseDates(nextCache.get(course.id)) === null);
      const notice = currentIds.length
        ? unknownDates ? "部分课程缺少日期，未计入当前学期；可切换学期或查看 Dashboard 上的课程。" : ""
        : dashboardIds.length
        ? "课程日期未能确定当前学期，先显示 Dashboard 上的课程；可切换学期。"
        : "课程日期未能确定当前学期，请从上方选择学期。";
      coursesById.clear(); for (const [id, raw] of nextCache) coursesById.set(id, raw);
      toolsByCourse.clear();
      return {ok: true, origin: canvasOrigin(), courses, terms: [...termsByKey.values()], currentIds, dashboardIds, defaultScope, notice};
    } catch (cause) { return resultError(cause); }
  }

  function hidden(element) {
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
          /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(node.getAttribute("style") || "")) return true;
    }
    return false;
  }

  function pageContent(html) {
    if (typeof html !== "string" || !html.trim()) return {text: "", content: [], links: []};
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const omitted = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "NAV", "FORM", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SVG", "CANVAS", "OBJECT", "EMBED", "IFRAME"]);
    const blocks = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TR", "TABLE", "DL", "DT", "DD"]);
    function read(node, pre = false) {
      if (node.nodeType === 3) return pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, " ");
      if (node.nodeType !== 1 || omitted.has(node.tagName) || hidden(node)) return "";
      if (node.tagName === "BR" || node.tagName === "HR") return "\n";
      const value = [...node.childNodes].map((child) => read(child, pre || node.tagName === "PRE")).join("");
      if (node.tagName === "LI") return `\n• ${value.trim()}\n`;
      if (node.tagName === "TD" || node.tagName === "TH") return `${value}\t`;
      return blocks.has(node.tagName) ? `\n${value}\n` : value;
    }
    const text = read(parsed.body).replace(/\r/g, "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const links = [...parsed.querySelectorAll("a[href],iframe[src]")].filter((node) => !hidden(node)).map((node) => ({
      value: node.getAttribute(node.tagName === "IFRAME" ? "src" : "href"),
      label: clean(`${node.textContent || ""} ${node.getAttribute("title") || ""} ${node.getAttribute("aria-label") || ""}`)
    }));
    // Transfer only text and a small set of structural tags. Source attributes,
    // styles, links, embedded media and executable markup never enter the reader.
    const tags = {P: "p", DIV: "div", SECTION: "div", ARTICLE: "div", HEADER: "div", FOOTER: "div",
      H1: "h3", H2: "h3", H3: "h4", H4: "h4", H5: "h4", H6: "h4", UL: "ul", OL: "ol", LI: "li",
      STRONG: "strong", B: "strong", EM: "em", I: "em", BR: "br", PRE: "pre", CODE: "code", BLOCKQUOTE: "blockquote",
      TABLE: "table", THEAD: "thead", TBODY: "tbody", TR: "tr", TD: "td", TH: "th", DL: "div", DT: "p", DD: "p"};
    function structure(node) {
      if (node.nodeType === 3) return [node.nodeValue];
      if (node.nodeType !== 1 || omitted.has(node.tagName) || hidden(node)) return [];
      const children = [...node.childNodes].flatMap(structure);
      if (node.tagName === "HR") return [{tag: "br", children: []}];
      return tags[node.tagName] ? [{tag: tags[node.tagName], children}] : children;
    }
    return {text, content: structure(parsed.body), links};
  }

  function getParameter(params, name) {
    for (const [key, value] of params) if (key.toLowerCase() === name.toLowerCase()) return value;
    return "";
  }

  function panoptoLink(value, label, id) {
    let url;
    try { url = new URL(value, `${canvasOrigin()}/courses/${id}`); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const coursePath = `/courses/${id}/external_tools/`;
    if (url.origin === canvasOrigin() && url.pathname.startsWith(coursePath) && /^\d+\/?$/.test(url.pathname.slice(coursePath.length))) {
      if (!/panopto|lecture\s*(?:recordings?|videos?|capture)|课程录像|讲座录像|课堂录播|课程录播/i.test(label || "")) return null;
      // Keep the actual launch URL only in memory. A Canvas/Panopto handoff
      // may depend on its query; the probe returns a clean display URL later.
      return {url: url.href, label: clean(label) || "Panopto", kind: "tool"};
    }
    if (!/(^|\.)panopto\.(?:com|eu)$/i.test(url.hostname)) return null;
    if (/^\/Panopto\/Pages\/(?:Viewer|Embed)\.aspx$/i.test(url.pathname)) {
      const session = getParameter(url.searchParams, "id");
      if (!UUID.test(session)) return null;
      return {url: url.href, label: clean(label) || "Panopto 视频", kind: "video"};
    }
    if (/^\/Panopto\/Pages\/(?:EmbeddedList|Sessions\/List)\.aspx$/i.test(url.pathname)) {
      let folder = getParameter(url.searchParams, "folderID") || getParameter(new URLSearchParams(url.hash.slice(1)), "folderID");
      folder = folder.replace(/^"|"$/g, "");
      if (!UUID.test(folder)) return null;
      return {url: url.href, label: clean(label) || "Panopto 视频列表", kind: "folder"};
    }
    return null;
  }

  function sourceUrl(value, id, fallback) {
    try {
      const url = new URL(value, canvasOrigin());
      if (url.protocol === "https:" && url.origin === canvasOrigin() && !url.username && !url.password &&
          (url.pathname === `/courses/${id}` || url.pathname.startsWith(`/courses/${id}/pages/`) || url.pathname === `/courses/${id}/assignments/syllabus`)) {
        url.search = ""; url.hash = ""; return url.href;
      }
    } catch { /* Use the canonical course URL instead of an unrelated link. */ }
    return fallback;
  }

  async function getCourse(courseId) {
    try {
      const id = idText(courseId);
      if (!ID.test(id) || !coursesById.has(id)) throw fail("COURSE_NOT_LISTED", "请先点击“刷新”更新课程列表，再读取这门课程。");
      const raw = coursesById.get(id);
      const courseUrl = `${canvasOrigin()}/courses/${id}`;
      const syllabus = pageContent(raw.syllabus_body);
      const preferSyllabus = raw.default_view === "syllabus" && Boolean(syllabus.text);
      const frontPath = `/api/v1/courses/${id}/front_page`;
      const [frontResult, tabsResult] = await Promise.allSettled([
        preferSyllabus ? Promise.resolve(null) : request(frontPath, frontPath).then(({data}) => data),
        list(`/api/v1/courses/${id}/tabs`)
      ]);
      for (const result of [frontResult, tabsResult]) if (result.status === "rejected" && ["AUTH_REQUIRED", "RATE_LIMIT"].includes(result.reason?.code)) throw result.reason;
      let front = {text: "", links: []}, frontUrl = courseUrl, frontError = null;
      if (frontResult.status === "fulfilled" && frontResult.value !== null) {
        const page = frontResult.value;
        if (!page || typeof page !== "object" || Array.isArray(page)) frontError = fail("INVALID_RESPONSE", "课程首页返回了无法识别的内容。");
        else if (page.locked_for_user === true || page.published === false) frontError = fail("ACCESS_DENIED", "课程首页尚未向当前账户开放。");
        else {
          front = pageContent(page.body);
          const canonical = typeof page.url === "string" && page.url ? `${courseUrl}/pages/${encodeURIComponent(page.url)}` : courseUrl;
          frontUrl = sourceUrl(page.html_url, id, canonical);
        }
      } else if (frontResult.status === "rejected" && frontResult.reason?.code !== "NOT_FOUND") frontError = frontResult.reason;

      let intro;
      if (preferSyllabus || (!front.text && syllabus.text)) intro = {text: syllabus.text, content: syllabus.content, sourceLabel: "课程大纲", url: `${courseUrl}/assignments/syllabus`, state: "ready", message: frontError ? "首页读取未完成，已显示课程大纲。" : ""};
      else if (front.text) intro = {text: front.text, content: front.content, sourceLabel: raw.default_view === "wiki" ? "课程首页" : "课程页面", url: frontUrl, state: "ready", message: ""};
      else intro = {text: "", sourceLabel: "课程首页", url: courseUrl, state: frontError ? "error" : "empty", message: frontError ? resultError(frontError).message : "课程首页和大纲尚未提供文字介绍。"};

      const found = new Map();
      const add = (value, label) => { const link = panoptoLink(value, label, id); if (link && !found.has(link.url)) found.set(link.url, link); };
      if (tabsResult.status === "fulfilled") for (const tab of tabsResult.value) {
        if (!tab || tab.hidden === true || ["admins", "none"].includes(tab.visibility)) continue;
        add(tab.html_url, tab.label);
      }
      for (const link of [...front.links, ...syllabus.links]) add(link.value, link.label);
      const navigationState = tabsResult.status === "fulfilled" ? "ready" : "error";
      toolsByCourse.set(id, [...found.values()].filter(link => link.kind === "tool"));
      return {ok: true, id, intro, panoptoLinks: [...found.values()], navigationState,
        message: navigationState === "error" ? resultError(tabsResult.reason).message : ""};
    } catch (cause) { return resultError(cause); }
  }

  async function getVideoLinks(courseId, launchUrl) {
    const id = idText(courseId);
    if (!(toolsByCourse.get(id) || []).some(link => link.url === launchUrl)) return {ok: false, code: "BAD_TARGET", message: "请先读取这门课程的视频入口。"};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      // Read the inert launch HTML. Do not run its scripts or submit login forms.
      const response = await globalThis.fetch(launchUrl, {method: "GET", credentials: "include", redirect: "manual", cache: "no-store",
        headers: {Accept: "text/html"}, signal: controller.signal});
      if (response.status === 429) return {ok: false, code: "RATE_LIMIT", message: "请求过多，请稍后刷新。"};
      if (!response.ok || response.type === "opaqueredirect" || (response.url && new URL(response.url).origin !== canvasOrigin())) return {ok: true, links: []};
      const page = pageContent(await response.text());
      const links = page.links.map(link => panoptoLink(link.value, link.label, id)).filter(link => link && link.kind !== "tool");
      return {ok: true, links};
    } catch {return {ok: true, links: []};}
    finally {clearTimeout(timer);}
  }

  globalThis.CanvasOverviewClient = Object.freeze({version: VERSION, getCatalog, getCourse, getVideoLinks});
})();
