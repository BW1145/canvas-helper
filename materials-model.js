import {safeFilename, csvCell} from "./transcript-utils.js";
import {StreamingZipWriter} from "./zip.js";

export function fileKind(name) {
  const ext = String(name).match(/\.(pdf|pptx?|docx?)$/i)?.[1].toLowerCase();
  return ext === "pdf" ? "PDF" : ext?.startsWith("ppt") ? "PPT" : ext?.startsWith("doc") ? "Word" : "";
}
export const rowsOf = chapters => chapters.flatMap(chapter => chapter.rows || []);
export const selectable = row => Boolean(row.kind && !row.locked && !row.error && row.url);
export function matching(chapter, row, query, kind) {
  return (!kind || row.kind === kind) && query.trim().toLocaleLowerCase().split(/\s+/).every(word => `${chapter.name} ${row.name} ${(row.sources || []).map(s => s.title).join(" ")}`.toLocaleLowerCase().includes(word));
}
export function selectRows(selected, rows, checked) {
  for (const row of rows.filter(selectable)) checked ? selected.add(row.key) : selected.delete(row.key);
}
export async function readChapter(chapter, courseId, call, signal, fileCache = new Map()) {
  const result = {...chapter, rows: [], links: [], issues: [], ready: false};
  if (chapter.locked) return {...result, ready: true};
  const files = new Map(), links = new Map();
  const running = () => {if (signal?.aborted) throw new DOMException("已停止扫描。", "AbortError");};
  const pause = cause => {if (cause.name === "AbortError" || ["AUTH_REQUIRED", "RATE_LIMIT", "CATALOG_REQUIRED"].includes(cause.code)) throw cause;};
  const addLink = (ref, source) => {
    const key = `${ref.url}|${source.url}`;
    if (!links.has(key)) links.set(key, {title: ref.title, url: ref.url, source: source.url, sourceTitle: source.title, chapter: chapter.name, moduleId: chapter.id});
  };
  async function addFile(ref, source) {
    running();
    if (files.has(ref.id)) {const row = files.get(ref.id); if (!row.sources.some(s => s.url === source.url)) row.sources.push(source); return;}
    const row = {key: `${chapter.id}:${ref.id}`, id: ref.id, moduleId: chapter.id, chapter: chapter.name, name: ref.title, kind: fileKind(ref.title), size: null,
      sources: [source], locked: Boolean(ref.locked), error: "", url: null, message: ref.message || ""};
    if (!row.locked) {
      try {
        let data = fileCache.get(ref.id);
        if (!data) {data = await call("file", [courseId, ref.id], signal); fileCache.set(ref.id, data);}
        Object.assign(row, {name: data.name, kind: fileKind(data.name), size: data.size, url: data.url, locked: data.locked, message: data.message || ""});
        if (!row.kind) return;
        if (!row.url && !row.locked) row.error = "文件尚未提供下载地址，请重试。";
      } catch(cause) {pause(cause); row.error = cause.message;}
    }
    files.set(ref.id, row);
  }
  try {
    const data = await call("moduleItems", [courseId, chapter.id], signal);
    for (const item of data.items) {
      running();
      const source = {url: item.source, title: item.title};
      if (item.kind === "file") await addFile(item, source);
      else if (item.kind === "external") addLink(item, source);
      else if (item.kind === "page" && !item.locked) {
        try {
          const page = await call("pageLinks", [courseId, item.page], signal);
          for (const ref of page.refs) {
            if (ref.kind === "file") await addFile(ref, source);
            else if (ref.kind === "external") addLink(ref, source);
          }
        } catch(cause) {pause(cause); result.issues.push({title: item.title, message: cause.message});}
      } else if (item.kind === "page" && item.locked) result.issues.push({title: item.title, message: item.message});
    }
    result.ready = true;
  } catch(cause) {
    pause(cause); result.issues.push({title: "章节列表", message: cause.message});
  }
  result.rows = [...files.values()]; result.links = [...links.values()];
  return result;
}
function component(name, fallback) {
  return safeFilename(String(name || fallback), 90).replace(/^未命名讲座$/, fallback);
}
export function archiveRows(chapters, selected) {
  const result = [];
  chapters.forEach((chapter, index) => {
    const folder = `${String(index + 1).padStart(2,"0")} ${component(chapter.name, "章节")}`;
    const used = new Set();
    for (const row of chapter.rows || []) {
      if (!selected.has(row.key) || !selectable(row)) continue;
      const ext = row.name.match(/\.[^.]+$/)?.[0] || "";
      const stem = component(row.name.slice(0, row.name.length - ext.length), `资料-${row.id}`);
      let name = stem + ext, n = 2;
      while (used.has(name.toLocaleLowerCase())) name = `${stem} (${n++})${ext}`;
      used.add(name.toLocaleLowerCase());
      result.push({...row, filename: `${folder}/${name}`, status: "pending", error: "", permissionOrigin: null});
    }
  });
  return result;
}
export function publicLink(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    for (const key of [...url.searchParams.keys()]) if (/token|auth|signature|credential|secret|session|jwt|api.?key|verifier/i.test(key)) url.searchParams.delete(key);
    if (/(?:token|auth|signature|credential|secret|session|jwt|api.?key|verifier)=/i.test(url.hash)) url.hash = "";
    return url.href;
  } catch {return "";}
}
const escape = text => String(text ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[char]);
export function externalHtml(course, links) {
  const groups = new Map();
  for (const link of links) {
    const url = publicLink(link.url); if (!url) continue;
    if (!groups.has(link.moduleId)) groups.set(link.moduleId, {name: link.chapter, rows: []});
    groups.get(link.moduleId).rows.push(`<li><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(link.title)}</a><p>${escape(url)}</p><p>来源：<a href="${escape(publicLink(link.source))}" target="_blank" rel="noopener noreferrer">${escape(link.sourceTitle)}</a></p></li>`);
  }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(course.name)} · 外部链接</title><style>body{max-width:900px;margin:40px auto;padding:0 20px;font:16px/1.7 system-ui;color:#202a30}a{color:#17634f;overflow-wrap:anywhere}p{color:#5e6b73;overflow-wrap:anywhere;margin:4px 0}li{margin-bottom:24px}h2{margin-top:32px}</style><h1>${escape(course.name)} · 外部链接</h1><p>按课程章节整理的链接清单</p>${[...groups.values()].map(g => `<section><h2>${escape(g.name)}</h2><ul>${g.rows.join("")}</ul></section>`).join("") || "<p>本次扫描未发现外部链接。</p>"}</html>`;
}
export function checklist(rows) {
  const labels = {pending: "未完成", working: "未完成", success: "已保存", error: "失败"};
  const lines = [["章节", "文件", "类型", "保存位置", "状态", "原因", "来源页面"]];
  for (const row of rows) lines.push([row.chapter, row.name, row.kind, row.status === "success" ? row.filename : "", labels[row.status], row.error,
    row.sources.map(source => publicLink(source.url)).filter(Boolean).join(" | ")]);
  return "\uFEFF" + lines.map(line => line.map(csvCell).join(",")).join("\r\n");
}
export class MaterialsArchive {
  constructor(handle, course, rows, links, includeLinks) {
    this.handle = handle; this.course = {...course}; this.rows = rows.map(row => ({...row}));
    this.links = links.map(link => ({...link})); this.includeLinks = includeLinks;
    this.writer = null; this.checkpoint = {entries:0,offset:0}; this.saved = false; this.committed = new Set();
  }
  async run({getFile, fetchFile, signal, onUpdate = () => {}}) {
    this.saved = false;
    const sink = await this.handle.createWritable({keepExistingData: Boolean(this.writer)});
    let fatal = null;
    try {
      if (this.writer) await this.writer.resume(sink, this.checkpoint);
      else this.writer = new StreamingZipWriter(sink);
      for (const row of this.rows) {
        if (signal?.aborted) break;
        if (row.status === "success") continue;
        row.status = "working"; row.error = ""; onUpdate(row);
        try {
          const fresh = await getFile(row.id, signal);
          if (fresh.locked || !fresh.url) throw new Error(fresh.message || "文件目前无法下载，请刷新资料。");
          if (fileKind(fresh.name) !== row.kind || fresh.name.match(/\.[^.]+$/)?.[0].toLowerCase() !== row.name.match(/\.[^.]+$/)?.[0].toLowerCase()) throw new Error("文件格式已更新，请刷新资料后重新选择。");
          const stream = await fetchFile(fresh, {signal});
          await this.writer.add(row.filename, stream, {signal, onProgress: bytes => onUpdate(row, bytes)});
          row.status = "success"; row.permissionOrigin = null;
        } catch(cause) {
          row.status = signal?.aborted ? "pending" : "error";
          row.error = signal?.aborted ? "已停止" : cause.message || "文件下载未完成，请重试。";
          row.permissionOrigin = cause.permissionOrigin || null;
          if (this.writer.needsResume) {fatal = new Error("下载包写入中断，请检查保存位置后重试。"); break;}
          if (["AUTH_REQUIRED", "RATE_LIMIT", "CATALOG_REQUIRED"].includes(cause.code)) break;
        }
        onUpdate(row);
      }
      if (!fatal) {
        const checkpoint = this.writer.checkpoint();
        await this.writer.add("资料清单.csv", checklist(this.rows));
        if (this.includeLinks) await this.writer.add("外部链接.html", externalHtml(this.course, this.links));
        await this.writer.close(); this.saved = true; this.checkpoint = checkpoint;
        this.committed = new Set(this.rows.filter(row => row.status === "success").map(row => row.key));
      }
      if (fatal) throw fatal;
    } catch(cause) {
      // File System Access commits on close; an aborted write retains the last saved ZIP.
      try {await sink.abort?.();} catch { /* The stream may already be closed. */ }
      for (const row of this.rows) if (row.status === "success" && !this.committed.has(row.key)) {row.status = "pending"; row.error = "写入尚未保存，请重试。";}
      throw cause;
    }
    onUpdate(null);
  }
}
