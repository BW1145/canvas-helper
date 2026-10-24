import {probeCourseVideo, cancelVideoProbe} from "./course-probe.js";

const $ = (id) => document.getElementById(id);
const sourceParam = new URL(location.href).searchParams.get("sourceTab");
const state = {
  sourceTabId: sourceParam && /^\d+$/.test(sourceParam) ? Number(sourceParam) : null,
  catalog: null, scope: "", cache: new Map(), rows: new Map(), selectedId: null, query: "", readerLinksKey: "", readerContentKey: "",
  injected: false, busy: false, controller: null, activeRun: null, requestId: 0
};
const failure = (message, code = "CANVAS_ERROR") => Object.assign(new Error(message), {code});
const aborted = () => new DOMException("已停止整理。", "AbortError");
const pauseCodes = new Set(["AUTH_REQUIRED", "LOGIN_REQUIRED", "CANVAS_AUTH_REQUIRED", "RATE_LIMIT", "RATE_LIMITED"]);
function assertRunning(signal) { if (signal.aborted) throw aborted(); }
function status(message) { $("status").textContent = message; }

// The source-side request has its own timeout. Cancelling the overview stops
// scheduling work immediately and ignores any response still in flight.
function cancellable(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted());
    signal.addEventListener("abort", stop, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) stop();
  });
}

async function canvasCall(method, args, signal) {
  assertRunning(signal);
  if (state.sourceTabId === null) throw failure("请回到 Canvas Dashboard，点击浏览器扩展图标打开课程总览。", "NO_SOURCE");
  try {
    if (!state.injected) {
      await cancellable(chrome.scripting.executeScript({target: {tabId: state.sourceTabId}, world: "ISOLATED", files: ["canvas-client.js"]}), signal);
      state.injected = true;
    }
    let results = await cancellable(chrome.scripting.executeScript({
      target: {tabId: state.sourceTabId}, world: "ISOLATED",
      func: async (name, values) => {
        const client = globalThis.CanvasOverviewClient;
        if (!client || typeof client[name] !== "function") return {ok: false, code: "CLIENT_MISSING", message: "Canvas 页面已经刷新。"};
        return await client[name](...values);
      }, args: [method, args]
    }), signal);
    let result = results[0]?.result;
    if (result?.code === "CLIENT_MISSING") {
      state.injected = false;
      await cancellable(chrome.scripting.executeScript({target: {tabId: state.sourceTabId}, world: "ISOLATED", files: ["canvas-client.js"]}), signal);
      state.injected = true;
      results = await cancellable(chrome.scripting.executeScript({
        target: {tabId: state.sourceTabId}, world: "ISOLATED",
        func: async (name, values) => await globalThis.CanvasOverviewClient[name](...values), args: [method, args]
      }), signal);
      result = results[0]?.result;
    }
    assertRunning(signal);
    if (!result?.ok) throw failure(result?.message || "未能读取 Canvas 课程信息，请刷新。", result?.code || "CANVAS_RESPONSE_ERROR");
    return result;
  } catch (cause) {
    if (signal.aborted || cause.name === "AbortError") throw aborted();
    if (cause.code) throw cause;
    state.injected = false;
    throw failure("Canvas 标签页已关闭或离开了学校网站。请回到 Dashboard，再点击扩展图标。", "SOURCE_UNAVAILABLE");
  }
}

function visibleCourses() {
  if (!state.catalog) return [];
  const courses = state.catalog.courses || [];
  if (state.scope === "all") return courses;
  if (state.scope === "current" || state.scope === "dashboard") {
    const ids = new Set((state.scope === "current" ? state.catalog.currentIds : state.catalog.dashboardIds).map(String));
    return courses.filter((course) => ids.has(String(course.id)));
  }
  return courses.filter((course) => course.termKey === state.scope);
}

function scopeOptions(catalog) {
  const options = [];
  if (catalog.currentIds?.length) options.push({key: "current", name: "当前学期"});
  if (catalog.dashboardIds?.length) options.push({key: "dashboard", name: "Dashboard 上的课程"});
  for (const term of catalog.terms || []) options.push({key: term.key, name: term.name});
  options.push({key: "all", name: "全部可访问课程"});
  return options;
}

function renderScope() {
  if (!state.catalog) return;
  const options = scopeOptions(state.catalog);
  if (!options.some((option) => option.key === state.scope)) {
    state.scope = options.some((option) => option.key === state.catalog.defaultScope) ? state.catalog.defaultScope : options[0].key;
  }
  const nodes = options.map((option) => {
    const node = document.createElement("option");
    node.value = option.key; node.textContent = option.name;
    return node;
  });
  $("termSelect").replaceChildren(...nodes);
  $("termSelect").value = state.scope;
  $("scopeNotice").textContent = state.catalog.notice || "";
  $("scopeNotice").hidden = !state.catalog.notice;
}

function safeLink(value, course, allowPanopto = false) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, state.catalog?.origin);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.origin === state.catalog?.origin && new RegExp(`^/courses/${String(course.id).replace(/[^0-9]/g, "")}(?:/|$)`).test(url.pathname)) return url.href;
    if (allowPanopto && /(^|\.)panopto\.(com|eu)$/i.test(url.hostname)) return url.href;
  } catch { /* A malformed or unrelated link is not shown. */ }
  return null;
}

function link(label, href, className, courseId, control) {
  const node = document.createElement("a");
  node.textContent = label; node.href = href; node.className = className;
  node.target = "_blank"; node.rel = "noopener noreferrer";
  node.dataset.courseId = String(courseId); node.dataset.control = control;
  return node;
}

function videoLabel(video) {
  if (video?.status === "available") return Number.isInteger(video.count) && video.count > 0 ? `Panopto · ${video.count} 个视频` : "Panopto · 有视频";
  return ({checking: "Panopto · 正在检查", linked: "Panopto · 已找到入口", empty: "Panopto · 暂无视频", not_found: "Panopto · 未发现入口", error: "Panopto · 读取失败"})[video?.status] || "Panopto · 等待检查";
}

function setText(id, text) {
  const node = $(id), value = String(text ?? "");
  if (node.textContent !== value) node.textContent = value;
}

const narrowScreen = window.matchMedia("(max-width: 1199px)");
const contentTags = new Set(["p", "div", "h3", "h4", "ul", "ol", "li", "strong", "em", "br", "pre", "code", "blockquote", "table", "thead", "tbody", "tr", "td", "th"]);
function listedCourses() {
  const words = state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return visibleCourses().filter(course => words.every(word => `${course.code} ${course.name}`.toLocaleLowerCase().includes(word)));
}
function recordError(record) {
  return record?.error || (record?.detail?.intro?.state === "error" ? record.detail.intro.message || "介绍读取失败" : "") ||
    (record?.video?.status === "error" ? record.video.message || "视频状态读取失败" : "");
}
function syncReaderMode() {
  const open = state.selectedId !== null;
  $("overviewLayout").dataset.reading = String(open);
  document.body.dataset.reading = String(open);
  $("courseReader").hidden = !open;
  const modal = open && narrowScreen.matches;
  $("appToolbar").inert = modal;
  $("listColumn").inert = modal;
  $("courseReader").setAttribute("role", modal ? "dialog" : "complementary");
  if (modal) $("courseReader").setAttribute("aria-modal", "true");
  else $("courseReader").removeAttribute("aria-modal");
}
function selectCourse(id) {
  if (!listedCourses().some(course => String(course.id) === String(id))) return;
  const changed = state.selectedId !== String(id);
  state.selectedId = String(id); render();
  if (changed) $("courseReader").scrollTop = 0;
  $("readerTitle").focus({preventScroll: true});
}
function closeReader() {
  const id = state.selectedId;
  state.selectedId = null; render();
  const trigger = [...$("courseList").querySelectorAll(".course-select")].find(node => node.dataset.courseId === id);
  (trigger || $("courseSearch")).focus({preventScroll: true});
}
function renderContent(intro, fallback) {
  const content = Array.isArray(intro?.content) ? intro.content : null;
  const key = JSON.stringify([intro?.text, content, fallback]);
  if (state.readerContentKey === key) return;
  state.readerContentKey = key;
  const target = $("readerDescription");
  if (!content?.length) {target.textContent = intro?.text || fallback; return;}
  function node(value) {
    if (typeof value === "string") return document.createTextNode(value);
    if (!value || !contentTags.has(value.tag) || !Array.isArray(value.children)) return document.createTextNode("");
    const element = document.createElement(value.tag);
    element.append(...value.children.map(node));
    return element;
  }
  target.replaceChildren(...content.map(node));
}
function courseActions(course, record, prefix = "") {
  const id = String(course.id), home = safeLink(course.url, course);
  // The source already identified these entrances; allow users to open one while checks continue.
  const entrance = safeLink(record?.video?.url || record?.detail?.panoptoLinks?.[0]?.url, course, true);
  const actions = [];
  if (home) actions.push(link("课程主页", home, "course-home-link", id, prefix + "home"));
  if (home && state.sourceTabId !== null) {
    const url = new URL("materials.html", location.href);
    url.search = new URLSearchParams({sourceTab: String(state.sourceTabId), course: id}).toString();
    actions.push(link("课程资料", url.href, "materials-link", id, prefix + "materials"));
  }
  if (entrance) actions.push(link("视频列表", entrance, "video-link", id, prefix + "video"));
  return actions;
}
function render() {
  const scope = visibleCourses(), courses = listedCourses();
  if (!courses.some(course => String(course.id) === state.selectedId)) state.selectedId = null;
  const active = document.activeElement;
  const focusId = active?.dataset?.courseId, focusControl = active?.dataset?.control;
  let restoreFocus = null;
  const rememberFocus = node => {
    if (focusId && node.dataset?.courseId === focusId && node.dataset?.control === focusControl) restoreFocus = node;
    return node;
  };
  $("refreshBtn").disabled = state.busy || state.sourceTabId === null;
  $("stopBtn").hidden = !state.busy;
  $("stopBtn").disabled = !state.busy;
  $("termSelect").disabled = !state.catalog;
  $("progress").hidden = !state.busy;
  setText("courseCount", state.query.trim() ? `${courses.length} / ${scope.length} 门` : `${scope.length} 门`);
  const finished = scope.reduce((total, course) => {
    const record = state.cache.get(String(course.id));
    return total + (record?.phase === "done" ? 2 : record?.detail ? 1 : 0);
  }, 0);
  $("progress").value = scope.length ? Math.round(finished / (scope.length * 2) * 100) : 0;
  $("emptyState").hidden = Boolean(courses.length);
  $("listLabels").hidden = !courses.length;
  $("clearSearchBtn").hidden = !state.query.trim();
  if (!courses.length && state.catalog) {
    setText("emptyTitle", state.query.trim() ? "没有匹配的课程" : "这个学期没有课程");
    setText("emptyText", state.query.trim() ? "试试课程名称中的其他词，或清空搜索。" : "可切换学期，或刷新课程列表。");
  }
  const rows = new Map();
  for (const course of courses) {
    const id = String(course.id), record = state.cache.get(id);
    const error = recordError(record);
    const rowKey = JSON.stringify([course, record?.video, record?.detail?.panoptoLinks, error, Boolean(error) && state.busy, state.selectedId === id, state.scope]);
    const previous = state.rows.get(id);
    if (previous?.key === rowKey) {rows.set(id, previous); continue;}
    const item = document.createElement("li"); item.className = "course-item"; item.dataset.selected = String(state.selectedId === id);
    const button = document.createElement("button"); button.type = "button"; button.className = "course-select";
    button.dataset.courseId = id; button.dataset.control = "select";
    button.setAttribute("aria-expanded", String(state.selectedId === id)); button.setAttribute("aria-controls", "courseReader");
    const code = document.createElement("span"); code.className = "course-code"; code.textContent = course.code || "课程";
    const name = document.createElement("span"); name.className = "course-name"; name.textContent = course.name || course.code || "未命名课程";
    button.append(code, name);
    if (state.scope === "all" || state.scope === "dashboard") {
      const term = document.createElement("span"); term.className = "course-term"; term.textContent = course.termName || "未注明学期"; button.append(term);
    }
    button.addEventListener("click", () => selectCourse(id));
    const info = document.createElement("div"); info.className = "course-state";
    const badge = document.createElement("span"); badge.className = `video-badge video-${record?.video?.status || "pending"}`;
    badge.textContent = videoLabel(record?.video).replace(/^Panopto · /, ""); info.append(badge);
    if (error) {
      const message = document.createElement("p"); message.className = "row-error"; message.textContent = error;
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "row-retry"; retry.textContent = "重试这门课程";
      retry.disabled = state.busy; retry.dataset.courseId = id; retry.dataset.control = "retry";
      retry.addEventListener("click", () => {void requestRun({retryId: id});});
      info.append(message, rememberFocus(retry));
    }
    const actions = document.createElement("div"); actions.className = "course-actions";
    actions.append(...courseActions(course, record).map(rememberFocus));
    // A completed retry returns keyboard focus to the course it updated.
    if (focusId === id && focusControl === "retry" && !error) restoreFocus = button;
    item.append(rememberFocus(button), info, actions); rows.set(id, {key: rowKey, node: item});
  }
  const list = $("courseList"), sameOrder = [...rows.keys()].join(",") === [...state.rows.keys()].join(",");
  if (sameOrder) {
    for (const [id, row] of rows) if (row.node !== state.rows.get(id).node) list.replaceChild(row.node, state.rows.get(id).node);
  } else list.replaceChildren(...[...rows.values()].map(row => row.node));
  state.rows = rows;
  const course = courses.find(course => String(course.id) === state.selectedId);
  if (course) {
    const id = String(course.id), record = state.cache.get(id), detail = record?.detail?.intro;
    setText("readerCode", course.code || "课程"); setText("readerTerm", course.termName || "未提供学期名称");
    setText("readerTitle", course.name || course.code || "未命名课程");
    const text = String(detail?.text || "");
    renderContent(detail, record?.error || detail?.message || (detail?.state === "empty" ? "课程首页和大纲暂未提供文字介绍。" : record?.phase === "reading" ? "正在读取课程介绍…" : "尚未读取课程介绍。"));
    $("readerDescription").className = "course-description" + (text ? detail?.content?.length ? " is-structured" : "" : record?.error || detail?.state === "error" ? " is-error" : " is-placeholder");
    const source = safeLink(detail?.url, course);
    $("readerSource").hidden = !source;
    if (source) {$("readerSource").href = source; setText("readerSource", `查看${detail.sourceLabel || "课程介绍"}原文`);}
    const video = record?.video;
    $("readerVideo").className = `video-badge video-${video?.status || "pending"}`;
    setText("readerVideo", videoLabel(video).replace(" · ", " "));
    setText("readerVideoMessage", video?.message || ""); $("readerVideoMessage").hidden = !video?.message;
    $("readerRetryBtn").hidden = !recordError(record); $("readerRetryBtn").disabled = state.busy;
    const links = courseActions(course, record, "reader-");
    const key = JSON.stringify([id, ...links.map(node => node.href)]);
    if (state.readerLinksKey !== key) {
      $("readerLinks").replaceChildren(...links.map(rememberFocus)); state.readerLinksKey = key;
    }
    const index = courses.indexOf(course);
    $("prevCourseBtn").disabled = index === 0; $("nextCourseBtn").disabled = index === courses.length - 1;
    setText("readerPosition", `${index + 1} / ${courses.length}`);
  }
  syncReaderMode();
  restoreFocus?.focus({preventScroll: true});
}

async function performRun(controller, {reloadCatalog = false, scope, retryId} = {}) {
  const signal = controller.signal;
  let currentRecord = null;
  state.busy = true; render();
  try {
    if (reloadCatalog || !state.catalog) {
      status("正在读取课程与学期…");
      const catalog = await canvasCall("getCatalog", [], signal);
      assertRunning(signal);
      state.catalog = catalog;
      if (reloadCatalog) state.cache.clear();
      state.scope = scope || state.scope || catalog.defaultScope;
      renderScope(); render();
    } else {
      if (scope) state.scope = scope;
      renderScope(); render();
    }
    if (retryId) state.cache.delete(String(retryId));
    const courses = visibleCourses().filter(course => !retryId || String(course.id) === String(retryId));
    // Read every introduction before checking video status in the background.
    for (let index = 0; index < courses.length; index++) {
      assertRunning(signal);
      const course = courses[index], id = String(course.id);
      if (state.cache.get(id)?.detail || state.cache.get(id)?.phase === "done") continue;
      currentRecord = state.cache.get(id) || {phase: "pending", detail: null, video: {status: "pending"}, error: ""};
      state.cache.set(id, currentRecord);
      currentRecord.error = ""; currentRecord.phase = "reading";
      status(`正在读取介绍 ${index + 1} / ${courses.length}`); render();
      try {
        currentRecord.detail = await canvasCall("getCourse", [id], signal);
        assertRunning(signal);
        currentRecord.phase = "ready"; render();
      } catch (cause) {
        if (signal.aborted || cause.name === "AbortError") throw aborted();
        currentRecord.error = cause.message || "课程介绍读取失败。";
        currentRecord.video = {status: "error", count: null, url: null, message: cause.message || "视频状态读取失败。"};
        currentRecord.phase = "done"; render();
        if (pauseCodes.has(cause.code)) throw cause;
      }
    }
    for (let index = 0; index < courses.length; index++) {
      assertRunning(signal);
      const course = courses[index], id = String(course.id);
      currentRecord = state.cache.get(id);
      if (!currentRecord?.detail || currentRecord.phase === "done") continue;
      status(`正在检查视频 ${index + 1} / ${courses.length}`);
      try {
        currentRecord.phase = "checking"; currentRecord.video = {status: "checking", message: "正在后台读取视频状态…"}; render();
        const record = currentRecord;
        const result = await probeCourseVideo({...course, ...record.detail}, {signal,
          resolveTool: (url) => canvasCall("getVideoLinks", [id, url], signal), onStatus(message) {
          if (!signal.aborted && typeof message === "string") {record.video.message = message; render();}
        }});
        assertRunning(signal);
        if (!["available", "empty", "not_found", "linked", "error"].includes(result?.status)) throw failure("视频列表未返回可识别的结果，请刷新。", "PROBE_RESPONSE_ERROR");
        currentRecord.video = result;
        currentRecord.phase = "done"; render();
        if (pauseCodes.has(result.code)) throw failure(result.message || "请完成学校登录后点“刷新”。", result.code);
      } catch (cause) {
        if (signal.aborted || cause.name === "AbortError") throw aborted();
        if (!currentRecord.detail) currentRecord.error = cause.message || "课程介绍读取失败。";
        currentRecord.video = {...currentRecord.video, status: "error", count: null, url: currentRecord.video?.url || null, message: cause.message || "视频状态读取失败。"};
        currentRecord.phase = "done"; render();
        if (pauseCodes.has(cause.code)) throw cause;
      }
    }
    const errors = courses.filter((course) => {
      const record = state.cache.get(String(course.id));
      return record?.error || record?.detail?.intro?.state === "error" || record?.video?.status === "error";
    }).length;
    status(courses.length ? `${retryId ? "课程已更新" : `已整理 ${courses.length} 门课程`}${errors ? `，${errors} 门需要重试。` : "。"}` : "这个范围内没有可读取的课程，请切换学期。");
  } catch (cause) {
    if (signal.aborted || cause.name === "AbortError") {
      if (currentRecord && currentRecord.phase !== "done") {
        currentRecord.phase = "pending"; currentRecord.video = {status: "pending", message: "已停止，刷新可继续检查。"};
      }
      status("已停止，已整理的课程信息保留在本页。");
    } else {
      status(cause.message || "课程读取失败，请刷新。");
      if (!state.catalog) {$("emptyTitle").textContent = "暂未读到课程列表"; $("emptyText").textContent = cause.message || "请检查 Canvas 登录状态后刷新。";}
    }
  } finally {
    await cancelVideoProbe().catch(() => {});
    if (state.controller === controller) {state.busy = false; state.controller = null; render();}
  }
}

async function requestRun(options = {}) {
  const requestId = ++state.requestId;
  if (state.activeRun) {
    state.controller?.abort();
    await state.activeRun;
  }
  if (requestId !== state.requestId) return;
  const controller = new AbortController();
  state.controller = controller;
  const task = performRun(controller, options);
  state.activeRun = task;
  await task;
  if (state.activeRun === task) state.activeRun = null;
}

function updateSearch() {
  state.query = $("courseSearch").value; render();
}
$("courseSearch").addEventListener("input", updateSearch);
$("clearSearchBtn").addEventListener("click", () => {$("courseSearch").value = ""; updateSearch(); $("courseSearch").focus();});
$("closeReaderBtn").addEventListener("click", closeReader);
$("readerRetryBtn").addEventListener("click", () => {if (state.selectedId) void requestRun({retryId: state.selectedId});});
$("prevCourseBtn").addEventListener("click", () => {const courses = listedCourses(); const index = courses.findIndex(course => String(course.id) === state.selectedId); if (index > 0) selectCourse(courses[index - 1].id);});
$("nextCourseBtn").addEventListener("click", () => {const courses = listedCourses(); const index = courses.findIndex(course => String(course.id) === state.selectedId); if (index >= 0 && index < courses.length - 1) selectCourse(courses[index + 1].id);});
$("termSelect").addEventListener("change", () => {state.selectedId = null; void requestRun({scope: $("termSelect").value});});
$("refreshBtn").addEventListener("click", () => {void requestRun({reloadCatalog: true, scope: state.scope});});
$("stopBtn").addEventListener("click", () => {state.requestId++; state.controller?.abort();});
narrowScreen.addEventListener("change", () => {
  syncReaderMode();
  if (state.selectedId && narrowScreen.matches) $("closeReaderBtn").focus({preventScroll: true});
});
window.addEventListener("keydown", event => {
  if (!state.selectedId) return;
  if (event.key === "Escape") {event.preventDefault(); closeReader(); return;}
  if (event.key !== "Tab" || !narrowScreen.matches) return;
  const controls = [...$("courseReader").querySelectorAll("button:not(:disabled), a[href]")].filter(node => node.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !controls.includes(active))) {event.preventDefault(); last?.focus();}
  else if (!event.shiftKey && (active === last || !controls.includes(active))) {event.preventDefault(); first?.focus();}
});
window.addEventListener("pagehide", () => {state.requestId++; state.controller?.abort(); void cancelVideoProbe().catch(() => {});});
void requestRun({reloadCatalog: true});
