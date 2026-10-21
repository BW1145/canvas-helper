// Course overview checks use GET requests only; no browsing tabs are created.
let activeController = null;
let activeOperation = null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const problem = (code, message) => Object.assign(new Error(message), {code});
const abortError = () => new DOMException("检查已停止。", "AbortError");
const parameter = (params, name) => [...params].find(([key]) => key.toLowerCase() === name)?.[1] || "";

function allowedLink(course, value) {
  try {
    const base = new URL(course.url), url = new URL(value, base);
    if (!/^[1-9]\d*$/.test(String(course.id)) || base.protocol !== "https:" || base.username || base.password ||
        base.pathname !== `/courses/${course.id}` || url.protocol !== "https:" || url.username || url.password) return null;
    if (url.origin === base.origin && new RegExp(`^/courses/${course.id}/external_tools/\\d+/?$`).test(url.pathname)) {
      return {launch: url.href, url: new URL(url.pathname, base.origin).href, kind: "tool"};
    }
    if (!/(^|\.)panopto\.(com|eu)$/i.test(url.hostname)) return null;
    if (/^\/Panopto\/Pages\/(?:Viewer|Embed)\.aspx\/?$/i.test(url.pathname)) {
      const id = parameter(url.searchParams, "id").toLowerCase();
      if (UUID.test(id)) return {url: `${url.origin}/Panopto/Pages/Viewer.aspx?id=${id}`, origin: url.origin, kind: "video", id};
    }
    if (/^\/Panopto\/Pages\/(?:EmbeddedList|Sessions\/List)\.aspx\/?$/i.test(url.pathname)) {
      let id = parameter(url.searchParams, "folderid") || parameter(new URLSearchParams(url.hash.replace(/^#\??/, "")), "folderid");
      try {id = decodeURIComponent(id);} catch {}
      id = id.replace(/^"|"$/g, "").toLowerCase();
      if (UUID.test(id)) return {url: `${url.origin}/Panopto/Pages/Sessions/List.aspx#folderID=${id}`, origin: url.origin, kind: "folder", id};
    }
  } catch {}
  return null;
}

function pending(link, message = "已找到视频入口，列表内容需进入后确认；请打开“视频列表”查看。") {
  return {status: "linked", count: null, url: link.url, message};
}

async function readVideo(link, signal) {
  const path = link.kind === "folder" ? `folders/${link.id}/sessions?pageNumber=0` : `sessions/${link.id}`;
  const target = `${link.origin}/Panopto/api/v1/${path}`;
  const response = await fetch(target, {method: "GET", credentials: "include", cache: "no-store", redirect: "manual",
    headers: {Accept: "application/json"}, signal});
  if (response.status === 429) throw problem("RATE_LIMIT", "请求过多，请稍后刷新。");
  if (response.status === 401 || response.status === 403 || response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400) || /text\/html/i.test(response.headers.get("content-type") || "")) return pending(link);
  if (!response.ok || (response.url && new URL(response.url).origin !== link.origin)) return pending(link, "已找到视频入口，后台暂未读到列表；可打开视频列表查看。");
  let data;
  try {data = JSON.parse(await response.text());} catch {return pending(link);}
  if (link.kind === "video") {
    return data?.Id?.toLowerCase() === link.id
      ? {status: "available", count: null, url: link.url, message: ""} : pending(link);
  }
  if (!Array.isArray(data?.Results) || data.Results.some(item => !UUID.test(item?.Id || "") || String(item?.Folder || "").toLowerCase() !== link.id)) return pending(link);
  return data.Results.length ? {status: "available", count: null, url: link.url, message: ""}
    : {status: "empty", count: 0, url: link.url, message: "视频列表目前为空。"};
}

async function runProbe(course, {signal, resolveTool, onStatus}) {
  const supplied = Array.isArray(course.panoptoLinks) ? course.panoptoLinks : [];
  if (!supplied.length) return {status: course.navigationState === "ready" ? "not_found" : "error", count: null, url: null,
    message: course.navigationState === "ready" ? "课程首页和导航中未发现 Panopto 入口。" : "未能读取课程的视频入口，请刷新。"};
  const links = [...new Map(supplied.map(item => allowedLink(course, item?.url)).filter(Boolean).map(item => [item.url, item])).values()];
  if (!links.length) return {status: "error", count: null, url: null, message: "课程视频入口地址无法识别。"};
  let unresolved = supplied.some(item => !allowedLink(course, item?.url)) || course.navigationState !== "ready", empty = null;
  for (const link of links) {
    if (signal.aborted) throw abortError();
    onStatus?.("正在后台读取视频状态…");
    try {
      const targets = link.kind === "tool"
        ? (await resolveTool?.(link.launch))?.links?.map(item => allowedLink(course, item?.url)).filter(item => item && item.kind !== "tool") || []
        : [link];
      if (!targets.length) unresolved = true;
      for (const target of targets) {
        if (signal.aborted) throw abortError();
        const result = await readVideo(target, signal);
        if (result.status === "available") return {...result, url: link.url};
        if (result.status === "empty") empty = {...result, url: link.url};
        else unresolved = true;
      }
    } catch (error) {
      if (signal.aborted || error.name === "AbortError") throw abortError();
      if (error.code === "RATE_LIMIT") return {status: "error", code: error.code, count: null, url: link.url, message: error.message};
      unresolved = true;
    }
  }
  return !unresolved && empty ? empty : pending(links[0]);
}

export function probeCourseVideo(course, {signal, resolveTool, onStatus, timeoutMs = 12000} = {}) {
  if (activeOperation) return Promise.reject(problem("PROBE_BUSY", "正在读取另一门课程，请稍后重试。"));
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, {once: true});
  activeController = controller;
  const links = (course.panoptoLinks || []).map(item => allowedLink(course, item?.url)).filter(Boolean);
  let timedOut = false;
  const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
  const cancelled = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(abortError()), {once: true}));
  if (signal?.aborted) controller.abort();
  activeOperation = Promise.race([cancelled, runProbe(course, {signal: controller.signal, resolveTool, onStatus})])
    .catch(error => {if (timedOut && links.length) return pending(links[0], "已找到视频入口，后台读取超时；可打开视频列表查看。"); throw error;})
    .finally(() => {clearTimeout(timer); signal?.removeEventListener("abort", stop); activeController = null; activeOperation = null;});
  return activeOperation;
}

// Cancels the current background check when leaving or changing the overview.
export async function cancelVideoProbe() {
  activeController?.abort();
  try {await activeOperation;} catch {}
}
