// Checks actual Panopto pages through the school's normal course launch.
// One inactive, muted tab is reused; the original Canvas tab is never changed.
let probeTab = null;
let activeOperation = null;
let activeController = null;
let blankSequence = 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pauseCodes = new Set(["LOGIN_REQUIRED", "AUTH_REQUIRED", "RATE_LIMIT"]);
const isPanopto = (url) => url.protocol === "https:" && /(^|\.)panopto\.(com|eu)$/i.test(url.hostname);
const abortError = () => new DOMException("检查已停止。", "AbortError");
const problem = (code, message) => Object.assign(new Error(message), {code});

function check(context) {
  if (context.signal.aborted) throw abortError();
  if (Date.now() >= context.deadline) throw problem("PROBE_TIMEOUT", "视频列表尚未完成加载，可打开课程的视频入口查看后重试。");
}

function bounded(promise, context) {
  check(context);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); context.signal.removeEventListener("abort", stop); };
    const stop = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => {
      cleanup(); reject(problem("PROBE_TIMEOUT", "视频列表尚未完成加载，可打开课程的视频入口查看后重试。"));
    }, Math.max(1, context.deadline - Date.now()));
    context.signal.addEventListener("abort", stop, {once: true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (context.signal.aborted) stop();
  });
}

async function pause(context, milliseconds = 300) {
  await bounded(new Promise(resolve => setTimeout(resolve, Math.min(milliseconds, Math.max(1, context.deadline - Date.now())))), context);
}

function uuid(value) {
  if (typeof value !== "string") return null;
  let result = value;
  for (let i = 0; i < 2; i++) { try { result = decodeURIComponent(result); } catch {} }
  result = result.replace(/^["'{]|["'}]$/g, "");
  return UUID.test(result) ? result.toLowerCase() : null;
}

function parameter(params, name) {
  for (const [key, value] of params) if (key.toLowerCase() === name) return value;
  return null;
}

function allowedLink(course, value) {
  try {
    const base = new URL(course.url);
    const url = new URL(value, base);
    if (base.protocol !== "https:" || base.username || base.password || !/^\d+$/.test(String(course.id)) ||
        !new RegExp(`^/courses/${course.id}/?$`).test(base.pathname) || url.protocol !== "https:" || url.username || url.password) return null;
    if (url.origin === base.origin && new RegExp(`^/courses/${course.id}/external_tools/\\d+/?$`).test(url.pathname)) {
      const canonical = new URL(url.pathname, base.origin).href;
      return {launch: url.href, url: canonical, kind: "tool"};
    }
    if (!isPanopto(url)) return null;
    if (/^\/Panopto\/Pages\/(?:Viewer|Embed)\.aspx\/?$/i.test(url.pathname)) {
      const id = uuid(parameter(url.searchParams, "id"));
      if (!id) return null;
      return {launch: url.href, url: `${url.origin}/Panopto/Pages/Viewer.aspx?id=${id}`, kind: "video", id};
    }
    if (/^\/Panopto\/Pages\/(?:EmbeddedList|Sessions\/List)\.aspx\/?$/i.test(url.pathname)) {
      const id = uuid(parameter(url.searchParams, "folderid")) || uuid(parameter(new URLSearchParams(url.hash.replace(/^#\??/, "")), "folderid"));
      if (!id) return null;
      return {launch: url.href, url: `${url.origin}/Panopto/Pages/Sessions/List.aspx#folderID=${id}`, kind: "folder", id};
    }
  } catch {}
  return null;
}

function detach(owner) {
  chrome.tabs.onActivated?.removeListener(owner.activated);
  chrome.tabs.onRemoved?.removeListener(owner.removed);
}

async function release(owner) {
  if (!owner) return;
  if (probeTab === owner) probeTab = null;
  try {
    if (!owner.closed && !owner.takenOver) {
      const tab = await chrome.tabs.get(owner.id);
      if (!owner.takenOver && !tab.active) await chrome.tabs.remove(owner.id);
    }
  } catch { /* The user may already have closed the temporary tab. */ }
  finally { detach(owner); }
}

function assertOwned(owner, context) {
  check(context);
  if (owner.closed) throw problem("PROBE_CLOSED", "视频检查标签页已关闭，请重新检查。");
  if (owner.takenOver) throw problem("PROBE_TAKEN_OVER", "你已打开检查标签页；该页已保留，可查看后重新检查。");
}

async function ensureTab(context) {
  if (probeTab) {
    try {
      const tab = await bounded(chrome.tabs.get(probeTab.id), context);
      if (tab.active) probeTab.takenOver = true;
      if (probeTab.closed || probeTab.takenOver) { detach(probeTab); probeTab = null; }
    } catch (error) {
      if (error.name === "AbortError" || error.code === "PROBE_TIMEOUT") throw error;
      detach(probeTab); probeTab = null;
    }
  }
  if (!probeTab) {
    check(context);
    // Await creation itself so cancellation can always clean up the returned id.
    const tab = await chrome.tabs.create({url: "about:blank", active: false});
    const owner = {id: tab.id, closed: false, takenOver: false};
    if (!Number.isInteger(owner.id)) throw problem("PROBE_CREATE_FAILED", "未能打开视频检查标签页，请重试。");
    owner.activated = info => { if (info.tabId === owner.id) owner.takenOver = true; };
    owner.removed = id => { if (id === owner.id) owner.closed = true; };
    chrome.tabs.onActivated?.addListener(owner.activated);
    chrome.tabs.onRemoved?.addListener(owner.removed);
    probeTab = owner;
    try { assertOwned(owner, context); await chrome.tabs.update(owner.id, {muted: true}); }
    catch (error) { await release(owner); throw error; }
  }
  assertOwned(probeTab, context);
  return probeTab;
}

async function clearPreviousDocument(owner, context) {
  assertOwned(owner, context);
  // A real extension document avoids about:blank hash-only navigations, which
  // need not emit loading/complete and may have a redacted Tab.url.
  const blank = chrome.runtime.getURL(`probe-reset.html?nonce=${++blankSequence}`);
  let listener, resolveLoad, rejectLoad, sawLoading = false;
  const loaded = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
  listener = (tabId, info) => {
    if (tabId !== owner.id) return;
    if (info.status === "loading") sawLoading = true;
    if (info.status === "complete" && sawLoading) resolveLoad();
  };
  chrome.tabs.onUpdated.addListener(listener);
  try {
    const navigation = chrome.tabs.update(owner.id, {url: blank, active: false}).then(tab => {
      if (tab.status === "complete" && tab.url === blank) resolveLoad();
    }, rejectLoad);
    await bounded(Promise.all([navigation, loaded]), context);
    assertOwned(owner, context);
  } finally { chrome.tabs.onUpdated.removeListener(listener); }
}

// Serialized by Chrome into the Panopto frame. Return only evidence, never DOM
// HTML, cookies or player request URLs. href stays inside the active check.
function inspectPanoptoFrame() {
  const visible = node => {
    if (!node || node.hidden || node.closest?.('[hidden],[aria-hidden="true"]')) return false;
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return Boolean(node.getClientRects?.().length);
  };
  const text = node => String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const all = selector => [...document.querySelectorAll(selector)];
  const alertText = all('#errorMessage,#error-message,#accessDenied,.error-message,.errorMessage,[role="alert"]')
    .filter(visible).map(text).join("\n");
  const pageLines = String(document.body?.innerText || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const denied = /(?:you (?:do not|don't) have (?:permission|access)|access (?:is )?denied|not authorized|not authorised|request access|not available to you|无权访问|没有权限|请求访问)/i;
  const missing = /(?:session (?:does not|doesn't) exist|video (?:does not|doesn't) exist|session (?:is |was )?(?:not found|deleted|unavailable)|content (?:is |was )?(?:not found|deleted)|视频(?:不存在|已删除)|找不到(?:此|该)?(?:视频|讲座))/i;
  const needsLogin = /\/(?:Login|SignIn)(?:\.aspx|\/|$)/i.test(location.pathname) || all('input[type="password"]').some(visible) ||
    /(?:you (?:must|need to) (?:log|sign) in|please (?:log|sign) in to (?:view|watch|access)|请(?:先)?登录)/i.test(alertText);
  let error = needsLogin ? "LOGIN_REQUIRED" : denied.test(alertText) ? "ACCESS_DENIED" : missing.test(alertText) ? "VIDEO_UNAVAILABLE" : null;
  if (!error && pageLines.some(line => line.length < 220 && /^(?:you (?:do not|don't) have (?:permission|access)|access denied|this (?:session|video) (?:does not exist|is not available)|无权访问|没有权限)/i.test(line))) error = "ACCESS_DENIED";
  const media = all("video,audio");
  const playerReady = media.some(item => !item.error && item.readyState >= 1 && item.duration > 0 && Boolean(item.currentSrc || item.getAttribute("src")));
  media.forEach(item => { try { item.pause(); } catch {} });
  const busy = all('[aria-busy="true"],#loading,.loading-spinner,.loading-indicator,[id*="loadingIndicator" i]').some(visible);
  const emptyNodes = all('[class*="empty" i],[id*="empty" i],[class*="nosession" i],[id*="nosession" i],[class*="novideo" i],[id*="novideo" i],[role="status"],#content,#main-content');
  const emptyPattern = /(?:there are no (?:videos|sessions|recordings)|no (?:videos|sessions|recordings) (?:to (?:display|show)|(?:were |are )?found|(?:are )?available|in this folder)|this folder (?:is empty|contains no (?:videos|sessions|recordings))|此文件夹(?:为空|没有(?:视频|录制))|没有(?:可显示的|可用的)?(?:视频|录制)|未找到(?:视频|录制))/i;
  const explicitEmpty = emptyNodes.some(node => visible(node) && emptyPattern.test(text(node)));
  const filtered = all('input[type="search"],input[id*="search" i],input[name*="search" i]').some(node => visible(node) && String(node.value || "").trim());
  return {href: location.href, timeOrigin: performance.timeOrigin, ready: document.readyState !== "loading", complete: document.readyState === "complete", error, playerReady, busy, explicitEmpty, filtered};
}

async function inspectFrame(owner, frame, link, context, startedAt) {
  assertOwned(owner, context);
  let frameOrigin;
  try { frameOrigin = new URL(frame.origin); } catch { return null; }
  if (!isPanopto(frameOrigin) || frame.tabId !== owner.id) return null;
  const injected = await bounded(chrome.scripting.executeScript({target: {tabId: owner.id, frameIds: [frame.frameId]}, func: inspectPanoptoFrame}), context);
  assertOwned(owner, context);
  const observation = injected?.[0];
  const evidence = observation?.result;
  if (!evidence || !Number.isFinite(evidence.timeOrigin) || evidence.timeOrigin < startedAt - 1 || !evidence.ready) return null;
  let here;
  try { here = new URL(evidence.href); } catch { return null; }
  if (here.origin !== frameOrigin.origin || !isPanopto(here)) return null;
  if (evidence.error) {
    const messages = {LOGIN_REQUIRED: "Panopto 需要重新登录，请从课程的视频入口完成登录后重新检查。", ACCESS_DENIED: "当前账号无法访问这个视频列表。", VIDEO_UNAVAILABLE: "这个视频已不可用。"};
    return {status: "error", count: null, url: link.url, code: evidence.error, message: messages[evidence.error] || "视频页面返回了访问错误。"};
  }
  const isViewer = /\/Pages\/(?:Viewer|Embed)\.aspx\/?$/i.test(here.pathname);
  if (isViewer) {
    if (link.kind === "video" && uuid(parameter(here.searchParams, "id")) !== link.id) return null;
    if (evidence.playerReady) return {status: "available", count: null, url: link.url, message: ""};
    return null;
  }
  if (!/\/Pages\/(?:EmbeddedList|Sessions\/List)\.aspx\/?$/i.test(here.pathname)) return null;
  const options = typeof observation.documentId === "string" ? {documentId: observation.documentId} : {frameId: frame.frameId};
  const response = await bounded(chrome.tabs.sendMessage(owner.id, {type: "PBT_SCAN"}, options), context);
  assertOwned(owner, context);
  const scan = response?.ok && response.scan;
  if (!scan || scan.href !== evidence.href || scan.origin !== here.origin) return null;
  if (link.kind === "folder" && scan.folderId !== link.id) return null;
  const sessions = (scan.sessions || []).filter(session => UUID.test(session.id || "") &&
    (session.sources || []).some(source => !source.startsWith("current-")));
  const pagination = scan.pagination || {};
  if (sessions.length) {
    const count = pagination.confidence === "high" && !pagination.controlConflict && pagination.countMatchesRange === true &&
      Number.isSafeInteger(pagination.total) && pagination.total >= sessions.length ? pagination.total : null;
    return {status: "available", count, url: link.url, message: ""};
  }
  const confirmedZero = pagination.confidence === "high" && pagination.total === 0 && pagination.complete === true && !pagination.controlConflict;
  if (evidence.complete && !evidence.busy && !evidence.filtered && (confirmedZero || evidence.explicitEmpty)) {
    return {status: "empty", count: 0, url: link.url, message: "视频列表目前为空。"};
  }
  return null;
}

async function checkLink(link, context, onStatus) {
  const owner = await ensureTab(context);
  await clearPreviousDocument(owner, context);
  assertOwned(owner, context);
  onStatus?.("正在打开课程的视频入口…");
  const startedAt = Date.now();
  await bounded(chrome.tabs.update(owner.id, {url: link.launch, active: false}), context);
  let emptySince = null;
  while (true) {
    assertOwned(owner, context);
    const discovered = await bounded(chrome.runtime.sendMessage({type: "PBT_DISCOVER", tabId: owner.id}), context);
    assertOwned(owner, context);
    let empty = null, accessError = null, undetermined = false;
    const frames = (discovered?.frames || []).filter(frame =>
      /\/Pages\/(?:Viewer|Embed|EmbeddedList|Sessions\/List)\.aspx\/?$/i.test(frame.path || "") ||
      /\/(?:Login|SignIn)(?:\.aspx|\/|$)/i.test(frame.path || ""));
    for (const frame of frames) {
      try {
        const result = await inspectFrame(owner, frame, link, context, startedAt);
        if (!result) undetermined = true;
        if (result?.status === "available") return result;
        if (result?.status === "empty") empty = result;
        if (result?.status === "error") accessError = result;
      } catch (error) {
        if (error.name === "AbortError" || error.code) throw error;
        undetermined = true;
        // A frame can change while LTI is replacing the embedded document.
      }
    }
    if (accessError) return accessError;
    if (empty && !undetermined) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= 300 && Date.now() - startedAt >= 800) return empty;
    } else emptySince = null;
    onStatus?.("正在等待讲座列表加载…");
    await pause(context);
  }
}

async function runProbe(course, context, onStatus) {
  check(context);
  const supplied = Array.isArray(course.panoptoLinks) ? course.panoptoLinks : [];
  if (!supplied.length) return {status: course.navigationState === "ready" ? "not_found" : "error", count: null, url: null,
    message: course.navigationState === "ready" ? "课程首页和导航中未发现 Panopto 入口。" : "未能读取课程的视频入口，请重新检查。"};
  const unique = new Map();
  let invalidLinks = 0;
  for (const candidate of supplied) {
    const link = allowedLink(course, candidate?.url);
    if (link) unique.set(link.url, link); else invalidLinks++;
  }
  const links = [...unique.values()].sort((a, b) => Number(a.kind === "video") - Number(b.kind === "video"));
  if (!links.length) return {status: "error", count: null, url: null, message: "未能识别课程视频入口的地址，可打开课程首页查看。"};
  let lastError = invalidLinks || course.navigationState !== "ready"
    ? {status: "error", count: null, url: links[0].url, message: "部分视频入口未能读取，请打开课程首页查看后重新检查。"} : null;
  let empty = null;
  for (let index = 0; index < links.length; index++) {
    check(context);
    context.safeUrl = links[index].url;
    const remaining = context.deadline - Date.now();
    const linkContext = {...context, deadline: Date.now() + Math.max(1, remaining / (links.length - index))};
    try {
      const result = await checkLink(links[index], linkContext, onStatus);
      if (pauseCodes.has(result.code)) return result;
      if (result.status === "available") return {...result, count: links.length === 1 && !invalidLinks ? result.count : null};
      if (result.status === "empty") empty = result;
      else lastError = result;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = {status: "error", count: null, url: links[index].url,
        code: typeof error.code === "string" ? error.code : undefined,
        message: typeof error.code === "string" ? error.message : "未能读取视频列表，请重新检查。"};
      if (pauseCodes.has(error.code)) return lastError;
      if (["PROBE_CLOSED", "PROBE_TAKEN_OVER"].includes(error.code)) break;
    }
  }
  return lastError || empty || {status: "error", count: null, url: links[0].url, message: "未能读取视频列表，请重新检查。"};
}

export function probeCourseVideo(course, {signal, onStatus, timeoutMs = 20000} = {}) {
  if (activeOperation) return Promise.reject(problem("PROBE_BUSY", "正在检查另一门课程，请稍后重试。"));
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", stop, {once: true});
  activeController = controller;
  const entrance = (Array.isArray(course?.panoptoLinks) ? course.panoptoLinks : []).map(link => allowedLink(course, link?.url)).find(Boolean);
  const context = {signal: controller.signal, safeUrl: entrance?.url || null,
    deadline: Date.now() + Math.min(20000, Math.max(100, Number(timeoutMs) || 20000))};
  activeOperation = runProbe(course, context, onStatus).catch(error => {
    if (error.name === "AbortError") throw error;
    return {status: "error", count: null, url: context.safeUrl, code: typeof error.code === "string" ? error.code : undefined,
      message: typeof error.code === "string" ? error.message : "未能读取视频列表，请重新检查。"};
  }).finally(async () => {
    signal?.removeEventListener("abort", stop);
    if (controller.signal.aborted) await release(probeTab);
    activeController = null; activeOperation = null;
  });
  return activeOperation;
}

export async function closeProbeTab() {
  activeController?.abort();
  try { await activeOperation; } catch {}
  await release(probeTab);
}
