import {probeCourseVideo, closeProbeTab} from "./course-probe.js";

const $ = (id) => document.getElementById(id);
const sourceParam = new URL(location.href).searchParams.get("sourceTab");
const state = {
  sourceTabId: sourceParam && /^\d+$/.test(sourceParam) ? Number(sourceParam) : null,
  catalog: null, scope: "", cache: new Map(), expanded: new Set(),
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
    if (!result?.ok) throw failure(result?.message || "未能读取 Canvas 课程信息，请重新读取。", result?.code || "CANVAS_RESPONSE_ERROR");
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
  return ({checking: "Panopto · 正在检查", empty: "Panopto · 暂无视频", not_found: "Panopto · 未发现入口", error: "Panopto · 读取失败"})[video?.status] || "Panopto · 等待检查";
}

function render() {
  const courses = visibleCourses();
  const active = document.activeElement;
  const focusId = active?.dataset?.courseId, focusControl = active?.dataset?.control;
  let restoreFocus = null;
  const rememberFocus = (node) => {
    if (node.dataset?.courseId === focusId && node.dataset?.control === focusControl) restoreFocus = node;
    return node;
  };
  $("refreshBtn").disabled = state.busy || state.sourceTabId === null;
  $("stopBtn").disabled = !state.busy;
  $("termSelect").disabled = !state.catalog;
  $("courseCount").textContent = `${courses.length} 门课程`;
  const finished = courses.reduce((total, course) => {
    const record = state.cache.get(String(course.id));
    return total + (record?.phase === "done" ? 2 : record?.detail ? 1 : 0);
  }, 0);
  $("progress").value = courses.length ? Math.round(finished / (courses.length * 2) * 100) : 0;
  $("progress").textContent = `${$("progress").value}%`;
  $("emptyState").hidden = Boolean(courses.length);
  if (!courses.length && state.catalog) {
    $("emptyTitle").textContent = "这个范围内没有课程";
    $("emptyText").textContent = "可切换学期，或重新读取课程列表。";
  }
  const fragment = document.createDocumentFragment();
  for (const course of courses) {
    const id = String(course.id), record = state.cache.get(id);
    const card = document.createElement("article");
    card.className = "card course-card"; card.setAttribute("role", "listitem"); card.dataset.courseId = id;
    const heading = document.createElement("header"); heading.className = "course-card-heading";
    const code = document.createElement("p"); code.className = "course-code"; code.textContent = course.code || "课程";
    const name = document.createElement("h2"); name.className = "course-name"; name.textContent = course.name || course.code || "未命名课程";
    const term = document.createElement("p"); term.className = "course-term"; term.textContent = course.termName || "未提供学期名称";
    heading.append(code, name, term);
    const intro = document.createElement("div"); intro.className = "course-intro";
    const description = document.createElement("p"); description.className = "course-description"; description.id = `intro-${id}`;
    const detail = record?.detail?.intro;
    const text = String(detail?.text || "");
    const canExpand = text.length > 180 || text.split("\n").length > 5;
    if (text) {
      description.textContent = text;
      if (canExpand && !state.expanded.has(id)) description.className += " is-collapsed";
    } else {
      description.textContent = record?.error || detail?.message || (detail?.state === "empty" ? "课程首页和大纲暂未提供文字介绍。" : record?.phase === "reading" ? "正在读取课程介绍…" : "尚未读取课程介绍。");
      description.className += record?.error || detail?.state === "error" ? " is-error" : " is-placeholder";
    }
    intro.append(description);
    if (canExpand) {
      const expand = document.createElement("button");
      expand.type = "button"; expand.className = "intro-expand";
      expand.textContent = state.expanded.has(id) ? "收起介绍" : "展开完整介绍";
      expand.dataset.courseId = id; expand.dataset.control = "expand";
      expand.setAttribute("aria-expanded", String(state.expanded.has(id))); expand.setAttribute("aria-controls", description.id);
      expand.addEventListener("click", () => {if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id); render();});
      intro.append(rememberFocus(expand));
    }
    const source = safeLink(detail?.url, course);
    if (source) intro.append(rememberFocus(link(`来源：${detail.sourceLabel || "课程介绍"} ↗`, source, "intro-source", id, "source")));
    const video = document.createElement("div"); video.className = "course-video";
    const badge = document.createElement("span");
    const videoState = record?.video?.status || "pending";
    badge.className = `video-badge video-${videoState}`; badge.textContent = videoLabel(record?.video);
    video.append(badge);
    if (record?.video?.message) {
      const message = document.createElement("p"); message.className = "video-message"; message.textContent = record.video.message; video.append(message);
    }
    const links = document.createElement("div"); links.className = "course-links";
    const home = safeLink(course.url, course);
    if (home) links.append(rememberFocus(link("打开课程 ↗", home, "course-home-link", id, "home")));
    const entrance = safeLink(record?.video?.url, course, true);
    if (entrance) links.append(rememberFocus(link("视频列表 ↗", entrance, "video-link", id, "video")));
    card.append(heading, intro, video, links); fragment.append(card);
  }
  $("courseGrid").replaceChildren(fragment);
  restoreFocus?.focus({preventScroll: true});
}

async function performRun(controller, {reloadCatalog = false, scope} = {}) {
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
    const courses = visibleCourses();
    // Read every introduction before starting slower Panopto redirects.
    for (let index = 0; index < courses.length; index++) {
      assertRunning(signal);
      const course = courses[index], id = String(course.id);
      if (state.cache.get(id)?.detail || state.cache.get(id)?.phase === "done") continue;
      currentRecord = state.cache.get(id) || {phase: "pending", detail: null, video: {status: "pending"}, error: ""};
      state.cache.set(id, currentRecord);
      currentRecord.error = ""; currentRecord.phase = "reading";
      status(`正在读取介绍 ${index + 1} / ${courses.length}：${course.name}`); render();
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
      status(`正在检查视频 ${index + 1} / ${courses.length}：${course.name}`);
      try {
        currentRecord.phase = "checking"; currentRecord.video = {status: "checking", message: "正在查看课程视频列表…"}; render();
        const record = currentRecord;
        const result = await probeCourseVideo({...course, ...record.detail}, {signal, onStatus(message) {
          if (!signal.aborted && typeof message === "string") {record.video.message = message; render();}
        }});
        assertRunning(signal);
        if (!["available", "empty", "not_found", "error"].includes(result?.status)) throw failure("视频列表未返回可识别的结果，请重新读取。", "PROBE_RESPONSE_ERROR");
        currentRecord.video = result;
        currentRecord.phase = "done"; render();
        if (pauseCodes.has(result.code)) throw failure(result.message || "请完成学校登录后点“重新读取”。", result.code);
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
    status(courses.length ? `已整理 ${courses.length} 门课程${errors ? `，其中 ${errors} 门有信息未能读取，可点“重新读取”。` : "。"}` : "这个范围内没有可读取的课程，请切换学期。");
  } catch (cause) {
    if (signal.aborted || cause.name === "AbortError") {
      if (currentRecord && currentRecord.phase !== "done") {
        currentRecord.phase = "pending"; currentRecord.video = {status: "pending", message: "已停止，重新读取可继续检查。"};
      }
      status("已停止，已整理的课程信息保留在本页。");
    } else {
      status(cause.message || "课程读取失败，请重新读取。");
      if (!state.catalog) {$("emptyTitle").textContent = "暂未读到课程列表"; $("emptyText").textContent = cause.message || "请检查 Canvas 登录状态后重新读取。";}
    }
  } finally {
    await closeProbeTab().catch(() => {});
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

$("termSelect").addEventListener("change", () => {void requestRun({scope: $("termSelect").value});});
$("refreshBtn").addEventListener("click", () => {void requestRun({reloadCatalog: true, scope: state.scope});});
$("stopBtn").addEventListener("click", () => {state.requestId++; state.controller?.abort();});
window.addEventListener("pagehide", () => {state.requestId++; state.controller?.abort(); void closeProbeTab().catch(() => {});});
void requestRun({reloadCatalog: true});
