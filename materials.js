import {createMaterialsSource} from "./materials-source.js";
import {fileKind, rowsOf, selectable, matching, selectRows, readChapter, archiveRows, MaterialsArchive, externalHtml, publicLink} from "./materials-model.js";
import {fetchMaterialStream, downloadOrigins} from "./materials-transfer.js";
import {safeFilename} from "./transcript-utils.js";

const $ = id => document.getElementById(id), params = new URL(location.href).searchParams;
const courseId = params.get("course"), sourceParam = params.get("sourceTab");
const sourceTab = sourceParam && /^\d+$/.test(sourceParam) ? Number(sourceParam) : null;
const call = createMaterialsSource(sourceTab);
const state = {course: null, chapters: [], selected: new Set(), collapsed: new Set(), query: "", kind: "", selectedOnly: false,
  scanning: false, downloading: false, scanController: null, downloadController: null, archive: null, linksOpen: false, objectUrls: new Set(), lastProgress: 0};
const status = text => {$("status").textContent = text;};
const allLinks = () => state.chapters.flatMap(chapter => chapter.links || []);
function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function node(tag, className, text) {
  const element = document.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
function button(text, handler, key, className = "text-button") {
  const control = node("button", className, text); control.type = "button"; control.dataset.focus = key; control.addEventListener("click", handler); return control;
}
function checkbox(label, key, handler) {
  const control = document.createElement("input"); control.type = "checkbox"; control.setAttribute("aria-label", label); control.dataset.focus = key;
  control.addEventListener("change", () => handler(control.checked)); return control;
}
function sourceLink(source) {
  const url = publicLink(source.url); if (!url) return node("span", "", source.title);
  const a = node("a", "", source.title); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; return a;
}
function visibleRows(chapter) {
  return (chapter.rows || []).filter(row => state.selectedOnly ? state.selected.has(row.key) : matching(chapter, row, state.query, state.kind));
}
function render() {
  const active = document.activeElement?.dataset?.focus;
  const eligible = new Set(rowsOf(state.chapters).filter(selectable).map(row => row.key));
  state.selected = new Set([...state.selected].filter(key => eligible.has(key)));
  $("scanBtn").disabled = state.scanning || state.downloading;
  $("scanStopBtn").hidden = !state.scanning;
  $("searchInput").disabled = state.selectedOnly;
  $("typeFilter").disabled = state.selectedOnly;
  $("clearBtn").disabled = state.downloading || !state.selected.size;
  $("includeLinks").disabled = state.downloading;
  $("downloadBtn").disabled = state.scanning || state.downloading || !state.selected.size;
  $("downloadBtn").textContent = state.archive ? "新建下载包" : "下载所选";
  $("stopBtn").hidden = !state.downloading;
  $("downloadBtn").hidden = state.downloading;
  $("selectedBtn").textContent = state.selectedOnly ? `返回全部 · 已选 ${state.selected.size} 个文件` : `已选 ${state.selected.size} 个文件`;
  const chosen = rowsOf(state.chapters).filter(row => state.selected.has(row.key));
  const bytes = chosen.reduce((sum,row) => sum + (row.size || 0),0);
  $("selectedSize").textContent = chosen.length ? `${chosen.some(row => row.size === null) ? "至少 " : "约 "}${formatSize(bytes)}` : "";
  const visible = state.chapters.flatMap(visibleRows).filter(selectable), checked = visible.filter(row => state.selected.has(row.key)).length;
  $("selectAll").checked = visible.length > 0 && checked === visible.length; $("selectAll").indeterminate = checked > 0 && checked < visible.length;
  $("selectAll").disabled = !visible.length || state.downloading;
  $("selectAllLabel").textContent = `显示的文件全选（${visible.length}）`;
  const sections = [];
  for (const chapter of state.chapters) {
    const rows = visibleRows(chapter);
    const filtered = state.selectedOnly || Boolean(state.query.trim() || state.kind);
    if (filtered && !rows.length) continue;
    const section = node("section", "chapter"), heading = node("div", "chapter-heading");
    const eligibleRows = rows.filter(selectable), selected = eligibleRows.filter(row => state.selected.has(row.key)).length;
    const check = checkbox(`选择章节：${chapter.name}`, `chapter-${chapter.id}`, value => {selectRows(state.selected, rows, value); render();});
    check.checked = eligibleRows.length > 0 && selected === eligibleRows.length; check.indeterminate = selected > 0 && selected < eligibleRows.length;
    check.disabled = !eligibleRows.length || state.downloading;
    const toggle = button("", () => {state.collapsed.has(chapter.id) ? state.collapsed.delete(chapter.id) : state.collapsed.add(chapter.id); render();}, `toggle-${chapter.id}`, "chapter-toggle");
    toggle.setAttribute("aria-expanded", String(!state.collapsed.has(chapter.id))); toggle.setAttribute("aria-controls", `chapter-${chapter.id}-body`);
    toggle.append(node("span", "chapter-name", chapter.name), node("span", "chapter-count", chapter.locked ? "尚未解锁" : `${rows.length} 个文件${selected ? ` · 已选 ${selected}` : ""}`));
    heading.append(check, toggle); section.append(heading);
    const body = node("div"); body.id = `chapter-${chapter.id}-body`; body.hidden = state.collapsed.has(chapter.id);
    for (const row of rows) {
      const item = node("div", "file-row"), info = node("div", "file-info");
      const input = checkbox(`选择文件：${row.name}`, `file-${row.key}`, value => {selectRows(state.selected, [row], value); render();});
      input.id = `file-${row.key}`; input.checked = state.selected.has(row.key); input.disabled = !selectable(row) || state.downloading;
      const label = node("label", "file-name", row.name); label.htmlFor = input.id; info.append(label);
      const sources = node("p", "file-source", "来自：");
      row.sources.forEach((source,index) => {if (index) sources.append(document.createTextNode(" / ")); sources.append(sourceLink(source));}); info.append(sources);
      if (row.locked || row.error) {
        info.append(node("p", "file-problem", row.error || row.message || "资料尚未解锁。"));
        if (row.error) {const retry = button("重试读取", () => {void retryFile(row);}, `retry-${row.key}`); retry.disabled = state.scanning || state.downloading; info.append(retry);}
      }
      const kind = node("span", "file-kind", row.kind || "待确认"); kind.dataset.kind = row.kind;
      item.append(input, info, kind, node("span", "file-size", formatSize(row.size))); body.append(item);
    }
    if (!rows.length) body.append(node("p", "chapter-message", chapter.locked ? chapter.message : chapter.ready ? "本章未发现 PDF、PPT 或 Word 文件。" : state.scanning ? "正在读取章节资料…" : "本章节尚未完整读取。"));
    for (const issue of chapter.issues || []) body.append(node("p", "chapter-message", `${issue.title}：${issue.message}`));
    if (!chapter.locked && (chapter.issues?.length || !chapter.ready) && !state.scanning) {
      const line = node("div", "chapter-issue"), retry = button("重试本章", () => {void scanChapter(chapter.id);}, `read-${chapter.id}`); retry.disabled = state.downloading; line.append(retry); body.append(line);
    }
    section.append(body); sections.push(section);
  }
  $("chapterList").replaceChildren(...sections);
  $("emptyState").hidden = sections.length > 0 || state.scanning;
  $("emptyTitle").textContent = state.selectedOnly ? "暂无已选文件" : state.chapters.length ? "没有匹配的文件" : "暂无章节资料";
  $("emptyText").textContent = state.selectedOnly ? "点击底部“返回全部”继续选择。" : state.chapters.length ? "可更换搜索词或文件类型。" : "可刷新重试，或回到 Canvas 检查 Modules。";
  renderLinks(); renderDownload();
  if (active) {
    const target = [...document.querySelectorAll("[data-focus]")].find(element => element.dataset.focus === active);
    (target || (state.selectedOnly ? $("selectedBtn") : null))?.focus({preventScroll:true});
  }
}
function renderLinks() {
  const links = allLinks(); $("linkCount").textContent = `${links.length} 条`; $("exportLinksBtn").disabled = !state.course || state.scanning || state.downloading;
  $("linksToggle").setAttribute("aria-expanded", String(state.linksOpen)); $("linksToggle").textContent = state.linksOpen ? "收起清单" : "查看清单";
  $("externalList").hidden = !state.linksOpen;
  if (!state.linksOpen) return;
  const groups = [];
  for (const chapter of state.chapters) {
    if (!chapter.links?.length) continue;
    const group = node("section", "external-group"); group.append(node("h3", "", chapter.name));
    for (const link of chapter.links) {
      const item = node("div", "external-item"); item.append(sourceLink({url:link.url,title:link.title}), node("p", "", publicLink(link.url)), node("p", "", `来源：${link.sourceTitle}`)); group.append(item);
    }
    groups.push(group);
  }
  $("externalList").replaceChildren(...groups.length ? groups : [node("p", "materials-note", "本次扫描未发现外部链接。")]);
}
function renderDownload(row, bytes) {
  const archive = state.archive; $("archivePanel").hidden = !archive;
  $("retryBtn").hidden = !archive || state.downloading || !archive.rows.some(r => r.status !== "success") && archive.saved;
  $("retryBtn").disabled = state.scanning;
  if (!archive) return;
  const count = archive.rows.filter(r => r.status === "success").length, failed = archive.rows.filter(r => r.status === "error").length;
  $("downloadProgress").value = archive.rows.length ? Math.round(count / archive.rows.length * 100) : 0;
  $("archiveStatus").textContent = state.downloading ? `已完成 ${count} / ${archive.rows.length}${row ? `，正在下载：${row.name}${bytes ? ` · ${formatSize(bytes)}` : ""}` : "，正在保存下载包…"}` : `${archive.saved ? `${archive.handle.name} 已保存` : "下载包尚未保存"}：${count} / ${archive.rows.length} 个文件完成${failed ? `，${failed} 个失败` : ""}。`;
  const labels = {pending:"待继续",working:"下载中",success:"已完成",error:"失败"};
  $("downloadResults").replaceChildren(...archive.rows.map(r => node("li", "", `${r.chapter} / ${r.name}：${labels[r.status]}${r.error ? `，${r.error}` : ""}`)));
}
async function scan() {
  if (state.scanning || state.downloading) return;
  if (!/^[1-9]\d*$/.test(courseId || "")) {status("请从课程总览的“课程资料”入口打开此页。"); return;}
  state.scanning = true; state.scanController = new AbortController(); render();
  const signal = state.scanController.signal;
  try {
    status("正在读取课程章节…");
    const catalog = await call("catalog", [courseId], signal);
    state.course = catalog.course; state.chapters = catalog.modules.map(chapter => ({...chapter, rows:[], links:[], issues:[], ready:false}));
    $("courseTitle").textContent = `${state.course.code || state.course.name} · 课程资料`;
    $("courseSubtitle").textContent = state.course.name; render();
    const cache = new Map();
    for (let index = 0; index < state.chapters.length; index++) {
      if (signal.aborted) break;
      status(`正在读取章节 ${index + 1} / ${state.chapters.length}：${state.chapters[index].name}`);
      state.chapters[index] = await readChapter(state.chapters[index],courseId,call,signal,cache); render();
    }
    status(signal.aborted ? "已停止扫描，可刷新或单独重试未完成章节。" : `已整理 ${state.chapters.length} 个章节，${rowsOf(state.chapters).length} 个文件，${allLinks().length} 条外部链接。`);
  } catch(cause) {status(cause.name === "AbortError" ? "已停止扫描，已读取资料保留在本页。" : cause.message);}
  finally {state.scanning = false; state.scanController = null; render();}
}
async function scanChapter(id) {
  if (state.scanning || state.downloading) return;
  const index = state.chapters.findIndex(c => c.id === id); if (index < 0) return;
  state.scanning = true; state.scanController = new AbortController(); render();
  try {state.chapters[index] = await readChapter(state.chapters[index],courseId,call,state.scanController.signal); status("章节资料已更新。");}
  catch(cause) {status(cause.name === "AbortError" ? "已停止扫描。" : cause.message);}
  finally {state.scanning = false; state.scanController = null; render();}
}
async function retryFile(row) {
  if (state.scanning || state.downloading) return;
  state.scanning = true; state.scanController = new AbortController(); render();
  try {
    const data = await call("file", [courseId,row.id],state.scanController.signal);
    Object.assign(row,{name:data.name,kind:fileKind(data.name),size:data.size,url:data.url,locked:data.locked,message:data.message,error:data.url || data.locked ? "" : "文件尚未提供下载地址。"});
    if (!row.kind) state.chapters.find(c => c.id === row.moduleId).rows = state.chapters.find(c => c.id === row.moduleId).rows.filter(r => r.key !== row.key);
    status("文件信息已更新。");
  } catch(cause) {if (cause.name !== "AbortError") row.error = cause.message; status(cause.message);}
  finally {state.scanning = false; state.scanController = null; render();}
}
async function download(retry = false) {
  if (state.downloading || state.scanning) return;
  const rows = retry ? state.archive?.rows.filter(row => row.status !== "success") || [] : archiveRows(state.chapters,state.selected);
  if (!retry && !rows.length) return;
  state.downloading = true; render();
  try {
    const origins = downloadOrigins(rows);
    if (origins.length && !await chrome.permissions.contains({origins})) {
      const granted = await chrome.permissions.request({origins});
      status(granted ? "下载站点已授权，请再次点击下载按钮选择保存位置并开始。" : "下载站点授权未完成，可稍后重试。");
      return;
    }
    if (!retry) {
      if (typeof window.showSaveFilePicker !== "function") throw new Error("请在桌面 Edge 中打开课程资料并选择 ZIP 保存位置。");
      const handle = await window.showSaveFilePicker({suggestedName: `${safeFilename(state.course.code || state.course.name)} - 课程资料.zip`, types:[{description:"ZIP 压缩包",accept:{"application/zip":[".zip"]}}]});
      state.archive = new MaterialsArchive(handle,state.course,rows,allLinks(),$("includeLinks").checked);
    }
    if (!state.archive) return;
    state.downloadController = new AbortController(); render();
    await state.archive.run({signal:state.downloadController.signal,getFile:(id,signal) => call("file",[courseId,id],signal),fetchFile:fetchMaterialStream,onUpdate(row,bytes) {
      const now = Date.now(); if (bytes && now - state.lastProgress < 250) return;
      state.lastProgress = now; renderDownload(row,bytes);
    }});
    status(state.downloadController.signal.aborted ? "已停止下载，已完成文件和清单已保存，可继续下载。" : "下载任务已保存，可在下方查看结果。");
  } catch(cause) {status(cause.name === "AbortError" ? "已取消保存位置选择。" : cause.code ? cause.message : "下载包保存未完成，请检查保存位置后重试。");}
  finally {state.downloading = false; state.downloadController = null; render();}
}
async function exportLinks() {
  if (!state.course) return;
  const url = URL.createObjectURL(new Blob([externalHtml(state.course,allLinks())],{type:"text/html;charset=utf-8"})); state.objectUrls.add(url);
  try {await chrome.downloads.download({url,filename:`${safeFilename(state.course.code || state.course.name)} - 外部链接.html`,saveAs:true,conflictAction:"uniquify"}); status("链接清单已提交给 Edge 保存。");}
  catch {URL.revokeObjectURL(url); state.objectUrls.delete(url); status("链接清单保存已取消，可再次导出。");}
}
$("backLink").href = `courses.html?${new URLSearchParams({sourceTab:String(sourceTab ?? "")})}`;
$("scanBtn").addEventListener("click",() => {void scan();});
$("scanStopBtn").addEventListener("click",() => state.scanController?.abort());
$("searchInput").addEventListener("input",() => {state.query = $("searchInput").value; render();});
$("typeFilter").addEventListener("change",() => {state.kind = $("typeFilter").value; render();});
$("selectAll").addEventListener("change",() => {selectRows(state.selected,state.chapters.flatMap(visibleRows),$("selectAll").checked); render();});
$("expandBtn").addEventListener("click",() => {state.collapsed.clear(); render();});
$("collapseBtn").addEventListener("click",() => {state.collapsed = new Set(state.chapters.map(c => c.id)); render();});
$("selectedBtn").addEventListener("click",() => {state.selectedOnly = !state.selectedOnly; state.collapsed.clear(); render();});
$("clearBtn").addEventListener("click",() => {state.selected.clear(); render();});
$("linksToggle").addEventListener("click",() => {state.linksOpen = !state.linksOpen; renderLinks();});
$("exportLinksBtn").addEventListener("click",() => {void exportLinks();});
$("downloadBtn").addEventListener("click",() => {void download();});
$("retryBtn").addEventListener("click",() => {void download(true);});
$("stopBtn").addEventListener("click",() => state.downloadController?.abort());
window.addEventListener("beforeunload",event => {if (state.downloading) {event.preventDefault(); event.returnValue = "";}});
window.addEventListener("pagehide",() => {state.scanController?.abort(); state.downloadController?.abort(); for (const url of state.objectUrls) URL.revokeObjectURL(url);});
void scan();
