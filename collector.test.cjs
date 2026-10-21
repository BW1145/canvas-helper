const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({ URL, URLSearchParams });
vm.runInContext(fs.readFileSync(path.join(__dirname, "collector.js"), "utf8"), context);
const collector = context.PanoptoCollector;
const ID = "abcdefab-abcd-abcd-abcd-abcdefabcdef";
const BASE = "https://example.au.panopto.com/Panopto/Pages/EmbeddedList.aspx";

assert.equal(collector.parseSessionUrl(`https://example.test/?id=${ID}`), null, "query UUID alone is not a lecture");
assert.equal(collector.parseSessionUrl(`/Panopto/Pages/Sessions/List.aspx?id=${ID}`, BASE), null, "folder pages are not lecture viewers");
assert.equal(collector.parseSessionUrl("/Panopto/Pages/Viewer.aspx?id=abcdefab", BASE), null, "reject truncated IDs");
assert.equal(collector.parseSessionUrl("javascript:alert(1)", BASE), null, "never treat script URLs as lectures");
assert.equal(collector.parseSessionUrl("data:text/plain,test", BASE), null, "never treat data URLs as lectures");
assert.equal(collector.parseSessionUrl(`/Panopto/Pages/Viewer.aspx?id=${ID}extra`, BASE), null, "reject UUID substrings");
assert.equal(collector.parseSessionUrl(`/Panopto/Pages/Embed.aspx?ID=${ID.toUpperCase()}&auth=do-not-copy#t=1`, BASE).url,
  `https://example.au.panopto.com/Panopto/Pages/Viewer.aspx?id=${ID}`, "canonical links retain the authorized origin but no unrelated query parameters");
assert.equal(collector.parseFolderId(`${BASE}?folderID=${ID}`), ID);
assert.equal(collector.parseFolderId(`https://example.test/Panopto/Pages/Sessions/List.aspx#folderID=%22${ID.toUpperCase()}%22`), ID);
assert.equal(collector.parseFolderId(`https://canvas.example.edu/courses/1?folderID=${ID}`), null, "do not infer Panopto folders from Canvas query parameters");
assert.equal(collector.parseFolderId(`${BASE}?unrelated=${ID}`), null, "only the explicit folderID parameter is accepted");

const emptyDoc = { title: "No loaded recordings", querySelectorAll() { return []; } };
const scan = collector.scanDocument(emptyDoc, BASE);
assert.equal(scan.pagination.hasNext, null, "unknown pagination must stay unknown");
assert.equal(scan.pagination.total, null);
assert.equal(scan.pagination.complete, false, "an empty DOM is not a complete folder");
assert.equal(scan.sessions.length, 0);
assert.equal(collector.findNextPageControl(emptyDoc), null);
assert.ok(scan.warnings.length > 0);
assert.equal(typeof collector.findNextPageControl, "function");
console.log("collector: 18 URL, unknown-state and interface assertions passed");
