const error = (code, message, extra = {}) => Object.assign(new Error(message), {code, ...extra});
function https(value) {
  try {const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url : null;} catch {return null;}
}
export function downloadOrigins(rows) {
  return [...new Set(rows.flatMap(row => [row.permissionOrigin, https(row.url) ? `${https(row.url).origin}/*` : null]).filter(Boolean))];
}
function signature(bytes, name) {
  const ext = name.match(/\.(pdf|pptx?|docx?)$/i)?.[1].toLowerCase();
  if (ext === "pdf") return new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().startsWith("%PDF-");
  if (ext?.endsWith("x")) return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  return [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((byte,index) => bytes[index] === byte);
}
export async function fetchMaterialStream(file, {signal, timeout = 45000} = {}) {
  const initial = https(file.url);
  if (!initial) throw error("INVALID_URL", "文件下载地址无效，请刷新资料。");
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer, observer, requestId = null, latest = initial;
  const resetTimer = () => {clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeout);};
  const event = globalThis.chrome?.webRequest?.onBeforeRedirect;
  const ownOrigin = globalThis.chrome?.runtime?.getURL?.("")?.replace(/\/$/, "");
  let tabId = null;
  if (event?.addListener && ownOrigin) {
    try {tabId = (await chrome.tabs.getCurrent())?.id ?? null;} catch { /* Match initiator and request URL when no tab is available. */ }
    observer = details => {
      if (details.initiator !== ownOrigin || details.type !== "xmlhttprequest" || tabId !== null && details.tabId >= 0 && details.tabId !== tabId) return;
      if (requestId === null) {if (details.url !== initial.href || !details.requestId) return; requestId = details.requestId;}
      else if (requestId !== details.requestId) return;
      latest = https(details.redirectUrl);
    };
    event.addListener(observer, {urls: ["https://*/*"], types: ["xmlhttprequest"]});
  }
  let response;
  resetTimer();
  try {
    response = await fetch(initial.href, {method: "GET", credentials: "include", redirect: "follow", signal: combined});
    if (!response.ok || response.status === 206) throw error("HTTP_ERROR", `文件下载未完成（HTTP ${response.status}）。`);
    const type = (response.headers.get("content-type") || "").split(";",1)[0].trim().toLowerCase();
    if (/^(?:text\/|application\/(?:json|xml|xhtml\+xml)$)/.test(type) || response.url && !https(response.url)) throw error("INVALID_FILE", "下载地址返回了网页，请确认 Canvas 登录后重试。");
    if (!response.body?.getReader) throw error("EMPTY_FILE", "文件未返回可下载内容。");
  } catch(cause) {
    clearTimeout(timer); controller.abort();
    if (response?.body) await response.body.cancel().catch(() => {});
    if (signal?.aborted) throw new DOMException("已停止下载。", "AbortError");
    if (typeof cause.code === "string") throw cause;
    if (cause.name === "AbortError") throw error("TIMEOUT", "文件连接超过 45 秒，请重试。");
    await new Promise(resolve => setTimeout(resolve, 0));
    if (latest && globalThis.chrome?.permissions?.contains && !await chrome.permissions.contains({origins:[`${latest.origin}/*`]})) {
      throw error("HOST_PERMISSION", "需要读取文件下载站点，点击重试后授权。", {permissionOrigin: `${latest.origin}/*`});
    }
    throw error("NETWORK_ERROR", "文件连接失败，请重试。");
  } finally {if (observer) event.removeListener(observer);}
  // Keep validation inside the ZIP transaction so incomplete bodies roll back.
  return (async function* () {
    const reader = response.body.getReader();
    let size = 0, checked = false, head = new Uint8Array(0), prefix = [], complete = false;
    const headerLength = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
    const length = headerLength !== null && /^\d+$/.test(headerLength) && (!encoding || encoding.toLowerCase() === "identity") ? Number(headerLength) : null;
    try {
      for (;;) {
        if (combined.aborted) throw new DOMException("下载中断。", "AbortError");
        const {done, value} = await reader.read();
        if (done) break;
        resetTimer();
        if (!(value instanceof Uint8Array)) throw error("INVALID_FILE", "文件内容无效，请重试。");
        size += value.byteLength;
        if (!checked) {
          prefix.push(value);
          const next = new Uint8Array(Math.min(1024, head.length + value.length));
          next.set(head); next.set(value.subarray(0,next.length-head.length),head.length); head = next;
          if (head.length < 8) continue;
          if (!signature(head, file.name)) throw error("INVALID_FILE", "返回内容与 PDF、PPT 或 Word 文件格式不匹配。");
          checked = true;
          for (const chunk of prefix) yield chunk;
          prefix = [];
        } else yield value;
      }
      if (!checked || size === 0) throw error("EMPTY_FILE", "文件为空或内容不完整，请重试。");
      if (Number.isSafeInteger(length) && length !== size || Number.isSafeInteger(file.size) && file.size !== size) throw error("INCOMPLETE_FILE", "文件大小与实际内容不一致，请重试。");
      complete = true;
    } catch(cause) {
      if (signal?.aborted) throw new DOMException("已停止下载。", "AbortError");
      if (controller.signal.aborted) throw error("TIMEOUT", "文件传输超过 45 秒未响应，请重试。");
      throw cause;
    } finally {
      clearTimeout(timer);
      if (!complete) Promise.resolve(reader.cancel()).catch(() => {});
      reader.releaseLock(); controller.abort();
    }
  })();
}
