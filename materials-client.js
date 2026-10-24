(() => {
  "use strict";
  const VERSION = "0.6.2";
  if (globalThis.CanvasMaterialsClient?.version === VERSION) return;
  const origin = location.origin;
  const ID = /^[1-9]\d*$/;
  const contexts = new Map();
  const fail = (code, message) => Object.assign(new Error(message), {code, materialsError: true});
  const id = value => {
    if ((typeof value === "number" && !Number.isSafeInteger(value)) || !ID.test(String(value))) throw fail("INVALID_ID", "课程资料编号无效，请刷新列表。");
    return String(value);
  };
  const clean = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const resultError = cause => ({ok: false, code: cause.materialsError ? cause.code : "NETWORK_ERROR", message: cause.materialsError ? cause.message : "课程资料读取失败，请重试。"});
  async function request(path, params = {}, list = false) {
    if (location.protocol !== "https:") throw fail("BAD_SOURCE", "请从已登录的 Canvas 页面打开课程资料。");
    const first = new URL(path, origin);
    for (const [key, value] of Object.entries(params)) first.searchParams.set(key, value);
    if (list) first.searchParams.set("per_page", "100");
    const allowed = new Set([...first.searchParams.keys(), "page"]), visited = new Set(), rows = [];
    let next = first.href;
    while (next) {
      const target = new URL(next, origin);
      if (target.origin !== origin || target.pathname !== path || target.username || target.password || target.hash || [...target.searchParams.keys()].some(key => !allowed.has(key))) throw fail("BAD_PAGINATION", "课程资料分页地址无效，已停止读取。");
      if (visited.has(target.href) || visited.size >= 100) throw fail("INCOMPLETE_LIST", "课程资料分页未能完整读取，请重试。");
      visited.add(target.href);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      let response, data;
      try {
        response = await fetch(target.href, {method: "GET", credentials: "include", redirect: "manual", cache: "no-store", headers: {Accept: "application/json+canvas-string-ids"}, signal: controller.signal});
        if (response.status === 401 || response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) throw fail("AUTH_REQUIRED", "请在 Canvas 完成登录后刷新资料。");
        if (response.status === 429) throw fail("RATE_LIMIT", "Canvas 请求较多，请稍后重试。");
        if (response.status === 403) throw fail("ACCESS_DENIED", "当前账户无法读取这项资料。");
        if (response.status === 404) throw fail("NOT_FOUND", "这项资料已移除或暂未提供。");
        if (!response.ok) throw fail("HTTP_ERROR", `资料读取失败（HTTP ${response.status}）。`);
        const final = new URL(response.url || target.href);
        if (final.origin !== origin || final.pathname !== path) throw fail("AUTH_REQUIRED", "Canvas 返回了跳转页面，请重新登录后刷新。");
        const text = await response.text();
        if (/text\/html/i.test(response.headers.get("content-type") || "") || /^\s*</.test(text)) throw fail("AUTH_REQUIRED", "Canvas 返回了登录页面，请重新登录后刷新。");
        try {data = JSON.parse(text);} catch {throw fail("INVALID_RESPONSE", "Canvas 返回的资料数据无效。");}
      } catch (cause) {
        if (cause.name === "AbortError") throw fail("TIMEOUT", "资料读取超过 20 秒，请重试。");
        throw cause;
      } finally {clearTimeout(timer);}
      if (!list) {
        if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("INVALID_RESPONSE", "Canvas 返回的资料数据无效。");
        return data;
      }
      if (!Array.isArray(data)) throw fail("INVALID_RESPONSE", "Canvas 未返回有效资料列表。");
      rows.push(...data);
      const header = response.headers.get("link") || "";
      const entries = [...header.matchAll(/<([^>]+)>\s*((?:;\s*[^,]*)*)/g)];
      const found = entries.find(([, , attrs]) => /;\s*rel\s*=\s*"?next"?(?:\s|;|$)/i.test(attrs));
      if (!found && /\brel\s*=\s*"?next\b/i.test(header)) throw fail("BAD_PAGINATION", "课程资料分页信息不完整。");
      next = found ? found[1] : null;
    }
    return rows;
  }
  function context(courseId) {
    const course = id(courseId), ctx = contexts.get(course);
    if (!ctx) throw fail("CATALOG_REQUIRED", "Canvas 页面已刷新，请重新读取课程资料。");
    return {course, ctx};
  }
  function external(value) {
    try {
      const url = new URL(value, origin);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      if (url.origin === origin) {
        if (!/^\/courses\/[1-9]\d*\/external_tools\//.test(url.pathname)) return null;
        url.search = ""; url.hash = "";
      } else {
        for (const key of [...url.searchParams.keys()]) if (/token|auth|signature|credential|secret|session|jwt|api.?key|verifier/i.test(key)) url.searchParams.delete(key);
        if (/(?:token|auth|signature|credential|secret|session|jwt|api.?key|verifier)=/i.test(url.hash)) url.hash = "";
      }
      return url.href;
    } catch {return null;}
  }
  function fileRef(value, course) {
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin) return null;
      const match = url.pathname.match(new RegExp(`^/(?:api/v1/)?(?:courses/${course}/)?files/([1-9]\\d*)(?:/(?:download|preview))?/?$`));
      return match ? id(match[1]) : null;
    } catch {return null;}
  }
  async function catalog(courseId) {
    const course = id(courseId), base = `/api/v1/courses/${course}`;
    const info = await request(base), modules = await request(`${base}/modules`, {}, true);
    if (id(info.id) !== course) throw fail("INVALID_RESPONSE", "Canvas 返回了其他课程的数据。");
    const normalized = modules.filter(m => m.published !== false && m.workflow_state !== "deleted").map(m => ({id: id(m.id), name: clean(m.name) || "未命名章节", position: Number(m.position) || 0,
      locked: m.state === "locked", message: m.state === "locked" ? "本章节尚未解锁。" : ""})).sort((a,b) => a.position - b.position);
    contexts.set(course, {modules: new Set(normalized.map(m => m.id)), pages: new Set()});
    return {ok: true, origin, course: {id: course, name: clean(info.name), code: clean(info.course_code), url: `${origin}/courses/${course}/modules`}, modules: normalized};
  }
  async function moduleItems(courseId, moduleId) {
    const {course, ctx} = context(courseId), module = id(moduleId);
    if (!ctx.modules.has(module)) throw fail("BAD_TARGET", "请先刷新章节列表。");
    const items = await request(`/api/v1/courses/${course}/modules/${module}/items`, {"include[]": "content_details"}, true);
    const result = [];
    for (const item of items.sort((a,b) => (a.position || 0) - (b.position || 0))) {
      if (item.published === false) continue;
      const title = clean(item.title) || "未命名资料", source = `${origin}/courses/${course}/modules/items/${id(item.id)}`;
      const locked = item.content_details?.locked_for_user === true;
      if (item.type === "File") {
        const fileId = id(item.content_id);
        result.push({kind: "file", id: fileId, title, source, locked, message: locked ? clean(item.content_details?.lock_explanation) || "资料尚未解锁。" : ""});
      } else if (item.type === "Page" && typeof item.page_url === "string" && item.page_url) {
        if (!locked) ctx.pages.add(item.page_url);
        result.push({kind: "page", page: item.page_url, title, source: `${origin}/courses/${course}/pages/${encodeURIComponent(item.page_url)}`, locked, message: locked ? "内容页面尚未解锁。" : ""});
      } else if (["ExternalUrl", "ExternalTool"].includes(item.type) && !locked) {
        const value = item.external_url || item.html_url, fileId = fileRef(value, course);
        if (fileId) result.push({kind:"file",id:fileId,title,source,locked:false});
        else {const url = external(value); if (url) result.push({kind: "external", title, url, source});}
      }
    }
    return {ok: true, items: result};
  }
  async function pageLinks(courseId, slug) {
    const {course, ctx} = context(courseId);
    if (!ctx.pages.has(slug)) throw fail("BAD_TARGET", "页面未出现在当前课程章节中。");
    const page = await request(`/api/v1/courses/${course}/pages/${encodeURIComponent(slug)}`);
    if (page.locked_for_user || page.published === false) throw fail("ACCESS_DENIED", clean(page.lock_explanation) || "内容页面尚未开放。");
    const parsed = new DOMParser().parseFromString(page.body || "", "text/html"), refs = [];
    for (const element of parsed.querySelectorAll("a[href],iframe[src]")) {
      let hidden = false;
      for (let n = element; n?.nodeType === 1; n = n.parentElement) if (["SCRIPT", "TEMPLATE", "STYLE", "NOSCRIPT"].includes(n.tagName) || n.hasAttribute("hidden") || n.getAttribute("aria-hidden") === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(n.getAttribute("style") || "")) hidden = true;
      if (hidden) continue;
      const value = element.getAttribute(element.tagName === "IFRAME" ? "src" : "href");
      const title = clean(element.textContent || element.getAttribute("title")) || "页面链接";
      const fileId = fileRef(value, course) || fileRef(element.getAttribute("data-api-endpoint"), course);
      if (fileId) refs.push({kind: "file", id: fileId, title});
      else {const url = external(value); if (url) refs.push({kind: "external", url, title});}
    }
    return {ok: true, refs};
  }
  async function file(courseId, fileId) {
    // Canvas authorizes this course-scoped request, including after a document navigation.
    const course = id(courseId), file = id(fileId);
    const data = await request(`/api/v1/courses/${course}/files/${file}`);
    if (id(data.id) !== file) throw fail("INVALID_RESPONSE", "Canvas 返回的文件编号不匹配。");
    let url = null;
    try {const u = new URL(data.url); if (u.protocol === "https:" && !u.username && !u.password) url = u.href;} catch { /* Keep metadata visible if download URL is absent. */ }
    return {ok: true, id: file, name: clean(data.filename || data.display_name) || `资料-${file}`, size: Number.isSafeInteger(data.size) && data.size >= 0 ? data.size : null,
      mime: clean(data["content-type"]), url, locked: data.locked_for_user === true || data.hidden_for_user === true, message: clean(data.lock_explanation)};
  }
  const wrap = fn => async (...args) => {try {return await fn(...args);} catch(cause) {return resultError(cause);}};
  globalThis.CanvasMaterialsClient = Object.freeze({version: VERSION, catalog: wrap(catalog), moduleItems: wrap(moduleItems), pageLinks: wrap(pageLinks), file: wrap(file)});
})();
