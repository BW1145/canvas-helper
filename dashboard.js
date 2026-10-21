import {cuesToText, srtToText, safeFilename, csvCell} from "./transcript-utils.js";
import {makeZip, StreamingZipWriter} from "./zip.js";
import {fetchVideoStream} from "./video-transfer.js";

const $ = (id) => document.getElementById(id);
const sourceParam = new URL(location.href).searchParams.get("sourceTab");
const state = {
  sourceTabId: sourceParam && /^\d+$/.test(sourceParam) ? Number(sourceParam) : null,
  sourceFrame: null, courseTitle: "课程转录稿", rows: [], selected: new Set(),
  busy: false, cancelled: false, totalExpected: null, workTabId: null,
  keepWorkTab: false, logs: [], urls: [], lastDownloadId: null,
  includeVideo: false, archive: null, activeVideoController: null, saving: false, pauseMessage: ""
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (message, code = "TASK_ERROR") => Object.assign(new Error(message), {code});
const statusText = {pending: "等待下载", working: "正在获取", success: "已获取", error: "未完成"};
const videoStatusText = {pending: "等待下载", working: "正在获取地址", downloading: "正在写入下载包", success: "已写入下载包", error: "未完成"};
const wantsVideo = (row) => Boolean(row.video?.requested || (state.includeVideo && state.selected.has(row.key)));
const rowDone = (row) => row.status === "success" && (!wantsVideo(row) || row.video?.status === "success");
const rowFailed = (row) => row.status === "error" || row.video?.status === "error";
const rowSettled = (row) => ["success", "error"].includes(row.status) && (!wantsVideo(row) || ["success", "error"].includes(row.video?.status));
const hasResults = () => state.rows.some((row) => ["success", "error"].includes(row.status) || ["success", "error"].includes(row.video?.status));
const fileStem = (row) => row.fileStem ||= `${String(state.rows.indexOf(row) + 1).padStart(3, "0")}_${safeFilename(row.title, 100)}_${row.id.slice(0, 8)}`;
const isOrigin = (value) => {
  try { const url = new URL(value); return url.protocol === "https:" && /(^|\.)panopto\.(com|eu)$/i.test(url.hostname); }
  catch { return false; }
};
function status(message) { $("status").textContent = message; }
function log(message) {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  state.logs.push(line);
  if (state.logs.length > 160) state.logs.shift();
  $("log").textContent = state.logs.join("\n");
}
function assertRunning() { if (state.cancelled) throw failure("任务已停止。", "CANCELLED"); }

function render() {
  const done = state.rows.filter(rowDone).length;
  const failed = state.rows.filter(rowFailed).length;
  const active = document.activeElement;
  const focusKey = active?.dataset?.sessionKey;
  const focusRole = active?.dataset?.sessionRole;
  let restoreFocus = null;
  $("countTotal").textContent = String(state.rows.length);
  $("countDone").textContent = String(done);
  $("countFailed").textContent = String(failed);
  $("progress").value = state.rows.length ? Math.round(state.rows.filter(rowSettled).length / state.rows.length * 100) : 0;
  $("progress").textContent = `${$("progress").value}%`;
  $("primaryBtn").disabled = state.busy || state.saving || state.sourceTabId === null;
  $("scanBtn").disabled = state.busy || state.saving || state.sourceTabId === null;
  $("downloadBtn").disabled = state.busy || state.saving || !state.selected.size;
  $("retryBtn").disabled = state.busy || state.saving || !state.rows.some((row) => state.selected.has(row.key) && (row.status === "error" || (state.includeVideo && row.video?.status === "error")));
  $("cancelBtn").disabled = !state.busy || state.saving;
  $("saveBtn").disabled = state.busy || state.saving || !hasResults();
  $("includeVideo").disabled = state.busy || state.saving;
  $("selectAll").disabled = state.busy || state.saving || !state.rows.length;
  $("selectAll").checked = Boolean(state.rows.length) && state.selected.size === state.rows.length;
  $("selectAll").indeterminate = state.selected.size > 0 && state.selected.size < state.rows.length;
  $("emptyState").hidden = Boolean(state.rows.length);
  const fragment = document.createDocumentFragment();
  for (const row of state.rows) {
    const card = document.createElement("article");
    card.className = "session-card";
    card.setAttribute("role", "listitem");
    const label = document.createElement("label");
    label.className = "session-select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(row.key);
    checkbox.disabled = state.busy || state.saving;
    checkbox.dataset.sessionKey = row.key;
    checkbox.dataset.sessionRole = "select";
    if (focusKey === row.key && focusRole === "select") restoreFocus = checkbox;
    checkbox.setAttribute("aria-label", `选择 ${row.title}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(row.key); else state.selected.delete(row.key);
      render();
    });
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = row.title;
    label.append(checkbox, title);
    const link = document.createElement("a");
    link.className = "session-link";
    link.href = row.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.textContent = "打开讲座 ↗";
    link.setAttribute("aria-label", `打开讲座：${row.title}`);
    link.dataset.sessionKey = row.key;
    link.dataset.sessionRole = "link";
    if (focusKey === row.key && focusRole === "link") restoreFocus = link;
    const result = document.createElement("div");
    result.className = "session-result";
    const badge = document.createElement("span");
    badge.className = `result-badge result-${row.status}`;
    badge.textContent = `转录稿：${statusText[row.status]}`;
    result.append(badge);
    if (row.error || row.language) {
      const detail = document.createElement("small");
      detail.className = "result-detail";
      detail.textContent = row.error || `字幕语言：${row.language}`;
      result.append(detail);
    }
    if (wantsVideo(row)) {
      const video = document.createElement("small");
      video.className = "video-detail";
      const progress = row.video?.status === "downloading" && Number.isFinite(row.video.percent) ? ` ${row.video.percent}%` : "";
      video.textContent = `视频：${videoStatusText[row.video?.status || "pending"]}${progress}${row.video?.error ? ` · ${row.video.error}` : ""}`;
      result.append(video);
    }
    card.append(label, link, result); fragment.append(card);
  }
  $("sessionsBody").replaceChildren(fragment);
  restoreFocus?.focus({preventScroll: true});
}

async function discover(tabId) {
  const response = await chrome.runtime.sendMessage({type: "PBT_DISCOVER", tabId});
  return (response?.frames || []).filter((frame) => isOrigin(frame.origin));
}
async function readFrame(frame) {
  const response = await chrome.tabs.sendMessage(frame.tabId, {type: "PBT_SCAN"}, {frameId: frame.frameId});
  if (!response?.ok || !response.scan) throw failure("未能读取内嵌的讲座列表。", "FRAME_UNAVAILABLE");
  return response.scan;
}
async function getSourceFrame() {
  if (state.sourceTabId === null) throw failure("请回到 Canvas 课程列表，从浏览器扩展图标启动。", "NO_SOURCE");
  try {
    const tab = await chrome.tabs.get(state.sourceTabId);
    if (tab.title) { state.courseTitle = tab.title; $("sourceLabel").textContent = tab.title; }
  } catch { throw failure("原课程标签页已经关闭。请重新打开课程列表，再点击扩展图标。", "SOURCE_CLOSED"); }
  let frames = await discover(state.sourceTabId);
  if (!frames.length) {
    status("正在刷新课程页，让新安装的扩展连接到 Panopto…");
    log("尚未发现 Panopto 页面，自动刷新来源标签页一次。");
    await chrome.tabs.reload(state.sourceTabId);
    const start = Date.now();
    while (!frames.length && Date.now() - start < 25000) {
      assertRunning(); await wait(750); frames = await discover(state.sourceTabId);
    }
  }
  if (!frames.length) throw failure("没有连接到 Panopto。请检查课程页是否已显示讲座列表；若停在学校登录页，先完成登录，再点击重试。", "NO_PANOPTO_FRAME");
  const choices = [];
  log(`检测到 ${frames.length} 个 Panopto 框架。`);
  for (const frame of frames) {
    try {
      const scan = await readFrame(frame);
      log(`页面 ${frame.path}：识别 ${scan.sessions?.length || 0} 条，分页证据 ${scan.pagination?.confidence || "none"}。`);
      if (scan.sessions?.length) choices.push({frame, scan});
    } catch { /* A frame may have navigated while the course was loading. */ }
  }
  if (!choices.length) {
    // Let dynamically loaded cards finish once, without an endless reload loop.
    await wait(1500);
    for (const frame of await discover(state.sourceTabId)) {
      try { const scan = await readFrame(frame); if (scan.sessions?.length) choices.push({frame, scan}); } catch {}
    }
  }
  if (!choices.length) throw failure("已连接 Panopto，但还没有识别到讲座链接。请复制下方诊断信息，以便适配这个页面。", "NO_SESSION_LINKS");
  const folders = choices.filter((choice) => choice.scan.folderId || /\/Sessions\/List\.aspx$/i.test(choice.frame.path));
  if (folders.length > 1 && new Set(folders.map((choice) => `${choice.frame.origin}/${choice.scan.folderId || choice.frame.frameId}`)).size > 1) {
    throw failure("页面中有多个讲座文件夹。请打开要下载的那门课程列表，再启动扩展。", "MULTIPLE_FOLDERS");
  }
  choices.sort((a, b) => Number(Boolean(b.scan.folderId)) - Number(Boolean(a.scan.folderId)) || b.scan.sessions.length - a.scan.sessions.length);
  const choice = folders[0] || choices[0];
  log(`已连接 ${choice.frame.origin} 的 Panopto 页面。`);
  return choice;
}

async function collectAll() {
  status("正在读取课程讲座列表…");
  const {frame, scan: initial} = await getSourceFrame();
  state.sourceFrame = frame;
  let scan = initial;
  if (scan.pagination?.hasPrevious === true) {
    log("当前列表不在第一页，尝试自动回到第一页。");
    const first = await chrome.tabs.sendMessage(frame.tabId, {type: "PBT_FIRST_PAGE"}, {frameId: frame.frameId});
    if (!first?.ok) throw failure("当前列表不在第一页，且未识别到第一页控件。请将列表切回第一页后重试。", "FIRST_PAGE_UNAVAILABLE");
    scan = first.scan;
  }
  const collected = new Map();
  // A failed rescan may leave only the first few pages visible. Keep the
  // committed rows so a later scan cannot append the same video twice.
  const prior = new Map(state.archive?.committedRows || []);
  for (const row of state.rows) {
    const saved = prior.get(row.key);
    const remembered = {...saved, ...row};
    if (saved?.data && !row.data) Object.assign(remembered, {data: saved.data, status: saved.status, error: saved.error, code: saved.code});
    if (saved?.video?.status === "success") Object.assign(remembered, {video: {...saved.video}, fileStem: saved.fileStem});
    prior.set(row.key, remembered);
  }
  const visited = new Set();
  let page = 0;
  let incomplete = null;
  state.totalExpected = scan.pagination?.total ?? null;
  while (true) {
    assertRunning(); page++;
    const signature = scan.sessions.map((session) => session.id).sort().join(",");
    if (visited.has(signature)) { incomplete = "翻页后出现了重复列表，已停止扫描以避免遗漏。"; break; }
    visited.add(signature);
    for (const session of scan.sessions) {
      let url;
      try { url = new URL(session.url); } catch { continue; }
      if (url.origin !== frame.origin || !isOrigin(url.href) || !/^[0-9a-f-]{36}$/i.test(session.id)) continue;
      const key = `${url.origin}/${session.id}`;
      const old = prior.get(key);
      collected.set(key, old ? {...old, launchUrl: session.launchUrl || old.launchUrl || session.url} : {
        id: session.id, url: session.url, launchUrl: session.launchUrl || session.url, origin: url.origin, key,
        title: session.title, status: "pending", error: "", code: "", data: null
      });
    }
    state.rows = [...collected.values()];
    state.selected = new Set(collected.keys());
    render();
    status(`已收集 ${collected.size}${state.totalExpected !== null ? ` / ${state.totalExpected}` : ""} 个讲座…`);
    log(`第 ${page} 页：发现 ${scan.sessions.length} 个讲座。`);
    if (scan.pagination?.expectedOnPage !== null && scan.pagination?.expectedOnPage !== undefined && scan.pagination.countMatchesRange === false) {
      incomplete = `本页显示应有 ${scan.pagination.expectedOnPage} 个讲座，但只识别到 ${scan.sessions.length} 个。`;
      break;
    }
    if (scan.pagination?.hasNext !== true) break;
    if (page >= 100) { incomplete = "列表超过 100 页，请按课程文件夹分批下载。"; break; }
    const next = await chrome.tabs.sendMessage(frame.tabId, {type: "PBT_NEXT_PAGE"}, {frameId: frame.frameId});
    if (!next?.ok) { incomplete = next?.message || "未能自动进入下一页。"; break; }
    scan = next.scan;
  }
  if (state.totalExpected !== null && collected.size !== state.totalExpected) incomplete ||= `页面总数是 ${state.totalExpected}，目前收集到 ${collected.size}。`;
  if (incomplete) throw failure(`${incomplete} 已保留识别到的列表；不会把部分结果标成整门课。`, "INCOMPLETE_LIST");
  if (!state.rows.length) throw failure("没有找到可下载的讲座。", "NO_SESSION_LINKS");
  if (state.totalExpected === null) log("页面未提供可核对的总数，下载范围是当前列表已识别到的讲座。");
  status(`已找到 ${state.rows.length} 个讲座，可以批量下载。`);
}

async function fetchInFrame(frame, row, pauseMedia = false, asset = "transcript") {
  if (frame.origin !== row.origin) return {ok: false, code: "BAD_ORIGIN", message: "讲座与登录页面不属于同一学校站点。"};
  try {
    await chrome.scripting.executeScript({target: {tabId: frame.tabId, frameIds: [frame.frameId]}, world: "MAIN", files: ["panopto-client.js"]});
    const results = await chrome.scripting.executeScript({
      target: {tabId: frame.tabId, frameIds: [frame.frameId]}, world: "MAIN",
      func: async (id, shouldPause, assetKind) => {
        if (shouldPause) document.querySelectorAll("video,audio").forEach((media) => { try { media.pause(); } catch {} });
        return assetKind === "video"
          ? await globalThis.PanoptoBatchClient.getVideoDownload(id)
          : await globalThis.PanoptoBatchClient.getTranscript(id);
      }, args: [row.id, pauseMedia, asset]
    });
    return results[0]?.result || {ok: false, code: "CONTEXT_GONE", message: "Panopto 页面已跳转，请重试。"};
  } catch { return {ok: false, code: "CONTEXT_GONE", message: "未能在已登录的 Panopto 页面执行请求。"}; }
}

async function openLectureAutomatically(row) {
  assertRunning();
  status("正在自动打开讲座并等待学校原有跳转…");
  log("内嵌页面请求未完成，尝试在静音讲座标签页中继续。");
  if (state.workTabId !== null) {
    try { await chrome.tabs.get(state.workTabId); } catch { state.workTabId = null; }
  }
  if (state.workTabId === null) {
    const tab = await chrome.tabs.create({url: "about:blank", active: false});
    state.workTabId = tab.id;
    await chrome.tabs.update(tab.id, {muted: true});
  }
  state.keepWorkTab = false;
  const launch = new URL(row.launchUrl || row.url);
  if (launch.origin !== row.origin) throw failure("讲座启动链接与课程不属于同一站点。", "BAD_ORIGIN");
  await chrome.tabs.update(state.workTabId, {url: launch.href});
  const start = Date.now();
  while (Date.now() - start < 25000) {
    assertRunning();
    await wait(600);
    const frames = await discover(state.workTabId);
    for (const frame of frames) {
      if (frame.origin !== row.origin || !/\/(Viewer|Embed)\.aspx$/i.test(frame.path)) continue;
      try {
        const result = await chrome.scripting.executeScript({target: {tabId: frame.tabId, frameIds: [frame.frameId]},
          func: () => new URL(location.href).searchParams.get("id")?.toLowerCase() || ""});
        if (result[0]?.result === row.id.toLowerCase()) { await wait(400); return frame; }
      } catch {}
    }
  }
  state.keepWorkTab = true;
  await chrome.tabs.update(state.workTabId, {active: true}).catch(() => {});
  throw failure("自动跳转后仍未取得登录状态。请检查新打开的学校页面，完成所需登录后，回到这里点击“重试失败”。", "LOGIN_REQUIRED");
}

function normalizeResult(result) {
  if (!result?.ok) throw failure(result?.message || "未能取得转录稿。", result?.code || "INVALID_RESPONSE");
  let text = "";
  if (result.kind === "cues" && Array.isArray(result.cues)) {
    text = cuesToText(result.cues);
  } else if (result.kind === "srt") {
    text = srtToText(result.raw);
  } else if (result.kind === "text") text = String(result.text || "");
  if (!text || !text.trim()) throw failure("未能从响应中提取转录稿文字。", "EMPTY_TRANSCRIPT");
  return {text, language: String(result.language || "默认")};
}

async function getAsset(row, asset = "transcript") {
  const fallbackCodes = new Set(["AUTH_REQUIRED", "EMPTY_RESPONSE", "HTML_RESPONSE", "NETWORK_ERROR", "UNKNOWN_CAPTIONS", "INVALID_RESPONSE", "SERVER_ERROR", "CONTEXT_GONE", "TIMEOUT", "VIDEO_API_ACCESS_DENIED", "VIDEO_VIEWER_REQUIRED"]);
  let result = await fetchInFrame(state.sourceFrame, row, false, asset);
  assertRunning();
  if (!result.ok && fallbackCodes.has(result.code)) {
    log(`第 ${state.rows.indexOf(row) + 1} 个讲座：${result.code}，自动尝试讲座页面。`);
    const frame = await openLectureAutomatically(row);
    result = await fetchInFrame(frame, row, true, asset);
    const initCodes = ["AUTH_REQUIRED", "EMPTY_RESPONSE", "HTML_RESPONSE", "CONTEXT_GONE"];
    if (asset === "video") initCodes.push("VIDEO_API_ACCESS_DENIED", "NO_VIDEO_DOWNLOAD");
    for (let attempt = 0; attempt < 2 && !result.ok && initCodes.includes(result.code); attempt++) {
      assertRunning();
      status("讲座页面已打开，正在等待登录与页面初始化…");
      await wait(1500 * (attempt + 1));
      result = await fetchInFrame(frame, row, true, asset);
    }
    if (!result.ok && ["AUTH_REQUIRED", "EMPTY_RESPONSE", "HTML_RESPONSE"].includes(result.code)) {
      state.keepWorkTab = true;
      await chrome.tabs.update(state.workTabId, {active: true}).catch(() => {});
      throw failure(`讲座页面仍未返回${asset === "video" ? "视频下载地址" : "转录稿"}。请检查新打开的页面是否需要登录，再回到这里点击“重试失败”。`, "LOGIN_REQUIRED");
    }
  }
  assertRunning();
  return result;
}

function pauseForFailure(code) {
  if (code === "VIDEO_HOST_PERMISSION") {
    state.pauseMessage = "需要读取视频下载站点。点击“重试失败”授权后继续。";
    status(state.pauseMessage); render(); return true;
  }
  if (["LOGIN_REQUIRED", "AUTH_REQUIRED", "HTML_RESPONSE"].includes(code)) {
    state.keepWorkTab = true;
    state.pauseMessage = "任务已暂停。请完成学校页面中的登录，再点击“重试失败”继续。";
    status(state.pauseMessage);
    render(); return true;
  }
  if (code === "RATE_LIMIT") {
    state.pauseMessage = "Panopto 要求放慢请求，任务已暂停。稍后点击“重试失败”继续。";
    status(state.pauseMessage);
    render(); return true;
  }
  return false;
}

function archiveName() {
  const date = new Date().toLocaleDateString("en-CA").replace(/[^\d-]/g, "-");
  return `${safeFilename(state.courseTitle, 70)}_讲座下载_${date}.zip`;
}

async function chooseArchive() {
  if (state.archive) return;
  if (typeof window.showSaveFilePicker !== "function") throw failure("请在桌面版 Edge 中打开扩展工作台，以选择下载包的保存位置。", "FILE_PICKER_UNAVAILABLE");
  // Called directly from the start button, before any network work or await.
  const handle = await window.showSaveFilePicker({
    suggestedName: archiveName(),
    types: [{description: "讲座下载包", accept: {"application/zip": [".zip"]}}]
  });
  state.archive = {handle, writer: null, sink: null, active: false, saveFailed: false,
    checkpoint: {entries: 0, offset: 0}, committedKeys: new Set(), committedRows: new Map()};
  state.lastDownloadId = null;
}

async function openArchive() {
  const archive = state.archive;
  if (!archive || archive.active) return;
  const rowKeys = new Set(state.rows.map((row) => row.key));
  if ([...archive.committedKeys].some((key) => !rowKeys.has(key))) {
    throw failure("课程列表已变化。请重新打开工作台，为这门课程选择一个新的下载包。", "ARCHIVE_COURSE_CHANGED");
  }
  let sink;
  try {
    sink = await archive.handle.createWritable({keepExistingData: Boolean(archive.writer)});
    if (archive.writer) await archive.writer.resume(sink, archive.checkpoint);
    else archive.writer = new StreamingZipWriter(sink);
    archive.sink = sink; archive.active = true;
  } catch {
    await sink?.abort().catch(() => {});
    throw failure("未能打开选定的下载包进行写入，请检查文件是否正被其他程序占用后重试。", "OUTPUT_WRITE_FAILED");
  }
}

async function rollbackArchive() {
  const archive = state.archive;
  if (!archive) return;
  await archive.sink?.abort().catch(() => {});
  archive.active = false; archive.saveFailed = true;
  for (const row of state.rows) {
    if (row.video?.status === "success" && !archive.committedKeys.has(row.key)) {
      Object.assign(row.video, {status: "error", code: "OUTPUT_WRITE_FAILED", error: "保存未完成，需重新下载这期视频。"});
    }
  }
}

async function* checkedVideoBytes(stream, signal, expectedBytes) {
  const reader = stream.getReader();
  let total = 0, prefixBytes = 0, checked = false;
  const pending = [];
  const cancelRead = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancelRead, {once: true});
  const checkPrefix = () => {
    const prefix = new Uint8Array(Math.min(prefixBytes, 512));
    let cursor = 0;
    for (const chunk of pending) {
      const length = Math.min(chunk.byteLength, prefix.length - cursor);
      prefix.set(chunk.subarray(0, length), cursor); cursor += length;
      if (cursor === prefix.length) break;
    }
    const text = new TextDecoder().decode(prefix).trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<\?xml\b|<Error(?:Response)?\b|#EXTM3U\b|\{\s*"(?:error|message)"\s*:)/i.test(text)) {
      throw failure("下载返回的内容不是视频文件。请检查讲座页面后重试。", "VIDEO_NOT_MEDIA");
    }
  };
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      const {done, value} = await reader.read();
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (!checked) {
        pending.push(value); prefixBytes += value.byteLength;
        if (prefixBytes < 512) continue;
        checkPrefix(); checked = true;
        for (const chunk of pending) yield chunk;
        pending.length = 0;
      } else yield value;
    }
    if (!total) throw failure("下载的视频文件为空。", "EMPTY_VIDEO");
    if (Number.isFinite(expectedBytes) && total !== expectedBytes) throw failure("视频数据未接收完整，请重试。", "INCOMPLETE_VIDEO");
    if (!checked) { checkPrefix(); for (const chunk of pending) yield chunk; }
  } finally {
    signal.removeEventListener("abort", cancelRead);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function downloadVideo(row, result) {
  if (!result?.ok) throw failure(result?.message || "未能取得视频下载地址。", result?.code || "NO_VIDEO_DOWNLOAD");
  let url;
  try { url = new URL(result.url); } catch { throw failure("视频下载地址无效。", "INVALID_VIDEO_URL"); }
  if (url.protocol !== "https:" || url.username || url.password) throw failure("视频下载地址无效。", "INVALID_VIDEO_URL");
  if (!state.archive?.active) throw failure("请先选择下载包的保存位置。", "NO_ARCHIVE");
  const format = String(result.format || result.filename?.match(/\.([a-z0-9]+)$/i)?.[1] || url.pathname.match(/\.([a-z0-9]+)$/i)?.[1] || "mp4").toLowerCase();
  const extension = ["mp4", "m4v", "webm", "mov", "mkv", "avi"].includes(format) ? format : "mp4";
  const filename = `${fileStem(row)}.${extension}`;
  const controller = new AbortController();
  state.activeVideoController = controller;
  Object.assign(row.video, {status: "downloading", filename, percent: null, permissionOrigin: null});
  render();
  try {
    assertRunning();
    const {stream, totalBytes} = await fetchVideoStream(url.href, {signal: controller.signal});
    let lastUpdate = 0;
    await state.archive.writer.add(filename, checkedVideoBytes(stream, controller.signal, totalBytes), {
      signal: controller.signal,
      onProgress: (bytes) => {
        const now = Date.now();
        if (now - lastUpdate < 300) return;
        lastUpdate = now;
        row.video.percent = totalBytes > 0 ? Math.min(99, Math.floor(bytes / totalBytes * 100)) : null;
        status(`正在写入视频${row.video.percent === null ? "" : ` ${row.video.percent}%`}：${row.title}`);
        render();
      }
    });
    Object.assign(row.video, {status: "success", percent: 100, error: "", code: ""});
    log(`第 ${state.rows.indexOf(row) + 1} 个讲座：视频已写入下载包。`);
  } catch (cause) {
    if (cause.name === "AbortError" || state.cancelled) throw failure("任务已停止。", "CANCELLED");
    throw cause;
  } finally {
    if (state.activeVideoController === controller) state.activeVideoController = null;
  }
}

async function downloadQueue(rows) {
  for (let index = 0; index < rows.length; index++) {
    assertRunning();
    const row = rows[index];
    if (state.includeVideo) row.video = {...(row.video || {status: "pending", error: "", code: ""}), requested: true};
    if (row.status !== "success") {
      row.status = "working"; row.error = ""; row.code = ""; render();
      status(`正在获取第 ${index + 1} / ${rows.length} 个讲座的转录稿：${row.title}`);
      try {
        row.data = normalizeResult(await getAsset(row)); row.language = row.data.language;
        row.status = "success";
        log(`第 ${state.rows.indexOf(row) + 1} 个讲座：已取得转录稿。`);
      } catch (cause) {
        if (cause.code === "CANCELLED") { row.status = "pending"; throw cause; }
        row.status = "error"; row.error = cause.message; row.code = cause.code || "TASK_ERROR";
        log(`第 ${state.rows.indexOf(row) + 1} 个讲座：转录稿 ${row.code}。`);
        if (pauseForFailure(row.code)) return;
      }
    }
    // Video is independent: a lecture without captions can still have a download.
    if (state.includeVideo && row.video.status !== "success") {
      assertRunning();
      Object.assign(row.video, {status: "working", error: "", code: "", percent: null});
      render(); status(`正在获取第 ${index + 1} / ${rows.length} 个讲座的视频：${row.title}`);
      try {
        await downloadVideo(row, await getAsset(row, "video"));
      } catch (cause) {
        if (cause.code === "CANCELLED") { row.video.status = "pending"; row.video.error = "已停止"; throw cause; }
        row.video.status = "error";
        row.video.error = typeof cause.code === "string" ? cause.message : "视频写入未完成，请重试。";
        row.video.code = cause.code || "VIDEO_DOWNLOAD_ERROR";
        row.video.permissionOrigin = cause.permissionOrigin || null;
        log(`第 ${state.rows.indexOf(row) + 1} 个讲座：视频 ${row.video.code}。`);
        if (state.archive?.writer.needsResume) throw failure("下载包写入中断，请检查磁盘空间后重试。", "OUTPUT_WRITE_FAILED");
        if (pauseForFailure(row.video.code)) return;
      }
    }
    render();
    if (index < rows.length - 1) await wait(800);
  }
  const done = state.rows.filter((row) => row.status === "success").length;
  const videos = state.rows.filter((row) => row.video?.status === "success").length;
  status(`处理完成：已取得 ${done} 份转录稿${state.includeVideo ? `、${videos} 个视频` : ""}。正在准备清单…`);
  if (hasResults()) await saveResults();
}

function resultFiles() {
  const files = [];
  const withVideo = state.rows.some((row) => row.video?.requested);
  const columns = withVideo ? ["讲座", "转录稿文件", "转录稿状态", "转录稿原因", "视频文件", "视频状态", "视频原因", "来源链接"] : ["讲座", "文件", "状态", "原因", "来源链接"];
  const checklist = [columns];
  for (const row of state.rows) {
    let filename = "";
    if (row.status === "success" && row.data) {
      filename = `${fileStem(row)}.txt`;
      const intro = `${row.title}\n来源：${row.url}\n字幕语言：${row.language}\n\n`;
      files.push({name: filename, data: intro + row.data.text});
    }
    const line = [row.title, filename, statusText[row.status], row.error || ""];
    if (withVideo) line.push(row.video?.status === "success" ? row.video.filename : "", row.video?.requested ? videoStatusText[row.video.status] : "未选择", row.video?.error || "");
    line.push(row.url);
    checklist.push(line);
  }
  const csv = checklist.map((line) => line.map(csvCell).join(",")).join("\r\n");
  files.push({name: "下载清单.csv", data: "\uFEFF" + csv});
  return files;
}

async function saveResults() {
  if (state.saving || (!hasResults() && !state.archive?.active)) return;
  state.saving = true; render();
  const successful = state.rows.filter((row) => row.status === "success" && row.data);
  const videos = state.rows.filter((row) => row.video?.status === "success").length;
  try {
    if (state.archive) {
      await openArchive();
      const archive = state.archive;
      // Keep completed videos, replacing only the TXT/CSV tail on each retry.
      const checkpoint = archive.writer.checkpoint();
      status("正在保存下载包…");
      for (const file of resultFiles()) await archive.writer.add(file.name, file.data);
      await archive.writer.close();
      archive.checkpoint = checkpoint;
      archive.committedKeys = new Set(state.rows.filter((row) => row.video?.status === "success").map((row) => row.key));
      archive.committedRows = new Map(state.rows.map((row) => [row.key, {...row, video: row.video ? {...row.video} : undefined}]));
      archive.active = false; archive.saveFailed = false;
      status(`${archive.handle.name} 已保存：${successful.length} 份转录稿、${videos} 个视频和一份清单。`);
      log("全部结果已保存到选定的同一个 ZIP。");
    } else {
      const blob = makeZip(resultFiles());
      const url = URL.createObjectURL(blob);
      state.urls.push(url);
      const id = await chrome.downloads.download({url, filename: archiveName(), saveAs: true, conflictAction: "uniquify"});
      state.lastDownloadId = id;
      const current = await chrome.downloads.search({id});
      status(current[0]?.state === "complete"
        ? `ZIP 已保存，包含 ${successful.length} 份转录稿和一份清单。可从 Edge 下载列表打开。`
        : `压缩包已提交给 Edge，包含 ${successful.length} 份转录稿和一份清单。可在下载列表查看保存进度。`);
      log("已请求保存转录稿和清单 ZIP。");
    }
    if (state.pauseMessage && state.archive) status(`${state.pauseMessage} 已完成内容已保存到选定的 ZIP。`);
  } catch (cause) {
    if (state.archive) {
      if (cause.code === "ARCHIVE_COURSE_CHANGED") throw cause;
      await rollbackArchive();
      throw failure("下载包未能保存，请检查磁盘空间和文件占用后重试。转录稿仍保留在本页。", "OUTPUT_WRITE_FAILED");
    }
    status("保存已取消或未完成。已获取的文字仍在本页，可以点击“保存已有结果”再次保存。");
    log("Edge 未完成保存请求；已保留本页中的下载结果。");
  } finally {
    state.saving = false; render();
  }
}

async function run(mode) {
  if (state.busy || state.saving) return;
  state.includeVideo = $("includeVideo").checked;
  state.busy = true; state.cancelled = false; state.pauseMessage = ""; render();
  try {
    if (mode !== "scan") {
      const origins = [...new Set(state.rows.filter((row) => state.includeVideo && state.selected.has(row.key) && row.video?.permissionOrigin).map((row) => row.video.permissionOrigin))];
      // Permission requests must be made in this click before other async work.
      if (origins.length && !await chrome.permissions.request({origins})) {
        throw failure("未获得视频站点读取授权，现有下载包已保留。", "VIDEO_HOST_PERMISSION");
      }
      if (state.includeVideo && !state.archive) await chooseArchive();
    }
    if (mode === "scan" || mode === "all") await collectAll();
    if (mode !== "scan") {
      if (!state.sourceFrame) await collectAll();
      let rows = state.rows.filter((row) => state.selected.has(row.key));
      if (mode === "retry") rows = rows.filter((row) => row.status !== "success" || (state.includeVideo && row.video?.status !== "success"));
      if (!rows.length) throw failure("请先勾选要下载的讲座。");
      if (state.archive) await openArchive();
      await downloadQueue(rows);
    }
  } catch (cause) {
    if (cause.name === "AbortError" && !state.archive) status("已取消保存位置选择。");
    else status(cause.code === "CANCELLED" ? "已停止，正在保存已完成内容…" : cause.message);
    log(cause.code === "CANCELLED" ? "用户停止了任务。" : `任务未完成：${cause.code || cause.name || "TASK_ERROR"}。`);
  } finally {
    state.rows.filter((row) => row.status === "working").forEach((row) => { row.status = "pending"; });
    state.rows.filter((row) => ["working", "downloading"].includes(row.video?.status)).forEach((row) => { row.video.status = "pending"; });
    if (state.archive?.active) {
      try { await saveResults(); }
      catch (cause) { status(cause.message); log("保存下载包未完成。"); }
    }
    if (state.cancelled && state.archive && !state.archive.active && !state.archive.saveFailed && hasResults()) {
      status(`已停止，已完成内容已保存到 ${state.archive.handle.name}。可继续下载未完成项。`);
    }
    if (state.workTabId !== null && !state.keepWorkTab) {
      await chrome.tabs.remove(state.workTabId).catch(() => {});
      state.workTabId = null;
    }
    state.busy = false; render();
  }
}

$("primaryBtn").addEventListener("click", () => run("all"));
$("scanBtn").addEventListener("click", () => run("scan"));
$("downloadBtn").addEventListener("click", () => run("selected"));
$("retryBtn").addEventListener("click", () => run("retry"));
$("cancelBtn").addEventListener("click", () => {
  state.cancelled = true;
  state.activeVideoController?.abort();
  status(state.archive ? "正在停止，并保存已完成内容…" : "正在停止，并保留已取得的结果。");
});
$("saveBtn").addEventListener("click", () => saveResults().catch((cause) => status(cause.message)));
$("includeVideo").addEventListener("change", (event) => { state.includeVideo = event.target.checked; render(); });
$("selectAll").addEventListener("change", (event) => {
  state.selected = event.target.checked ? new Set(state.rows.map((row) => row.key)) : new Set(); render();
});
$("copyDiagBtn").addEventListener("click", async () => {
  const diagnostics = {extensionVersion: "0.4.0", expectedCount: state.totalExpected, detectedCount: state.rows.length,
    successCount: state.rows.filter((row) => row.status === "success").length,
    videoCount: state.rows.filter((row) => row.video?.status === "success").length,
    failures: state.rows.map((row, index) => ({item: index + 1, status: row.status, code: row.code || "", videoCode: row.video?.code || ""})).filter((row) => row.status === "error" || row.videoCode),
    logs: state.logs};
  const text = JSON.stringify(diagnostics, null, 2);
  try { await navigator.clipboard.writeText(text); status("已复制诊断信息；不包含 Cookie、登录令牌或转录稿内容。"); }
  catch { $("log").textContent = text; status("请选中下方诊断文字并复制。"); }
});
chrome.downloads.onChanged.addListener((change) => {
  if (change.id !== state.lastDownloadId) return;
  if (change.state?.current === "complete") status("ZIP 已保存。可以从 Edge 的下载列表打开。");
  if (change.state?.current === "interrupted") status("ZIP 保存未完成。请点击“保存已有结果”重试。");
});
window.addEventListener("beforeunload", (event) => {
  if (state.busy || state.saving) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("unload", () => state.urls.forEach((url) => URL.revokeObjectURL(url)));
if (state.sourceTabId === null) status("请先从 Canvas 的 Panopto 课程列表点击扩展图标。");
else chrome.tabs.get(state.sourceTabId).then((tab) => { if (tab.title) { state.courseTitle = tab.title; $("sourceLabel").textContent = tab.title; } }).catch(() => {});
render();
