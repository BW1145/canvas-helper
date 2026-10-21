import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {makeZip} from "./zip.js";
import {cleanCaption, cuesToSrt, cuesToText, srtToText, safeFilename, csvCell} from "./transcript-utils.js";

const cues = [
  {text: "[Music] Kia ora &amp; welcome.", start: 0.8, duration: 2.2},
  {text: "Repeat repeat. <i>Music in Aotearoa.</i>", start: 3, duration: 4},
  {text: "Another section.", start: 12, duration: 2}
];
const text = cuesToText(cues);
assert.ok(text.includes("[Music] Kia ora & welcome."));
assert.ok(text.includes("Repeat repeat. Music in Aotearoa."));
assert.ok(text.includes("\n\nAnother section."));
const srt = cuesToSrt(cues);
assert.ok(srt.includes("00:00:00,800 --> 00:00:03,000"));
assert.equal(cuesToSrt([{text: "Unknown timing", start: null, duration: null}]), null);
assert.ok(srtToText(srt).includes("Repeat repeat."));
assert.equal(srtToText("<html><body>Sign in</body></html>"), null);
assert.equal(cleanCaption("Literal &lt;T&gt; and &#x1f3b5;"), "Literal <T> and 🎵");
assert.equal(safeFilename("../../MUS:125 | Lecture?"), ".._.._MUS_125 _ Lecture_");
assert.equal(safeFilename("CON.txt"), "_CON.txt");
assert.equal(csvCell("=1+2"), '"\'=1+2"');
assert.throws(() => makeZip([{name: "../../bad.txt", data: "no"}]));
const expected = [
  {name: "转录稿/001_音乐 🎵.txt", data: text},
  {name: "字幕/001_MUS125.srt", data: srt},
  {name: "empty.txt", data: ""}
];
const outputDir = new URL("../test-output/", import.meta.url);
fs.mkdirSync(outputDir, {recursive: true});
fs.writeFileSync(new URL("fixture-transcripts.zip", outputDir), new Uint8Array(await makeZip(expected, new Date("2026-10-17T09:00:00Z")).arrayBuffer()));
fs.writeFileSync(new URL("fixture-expected.json", outputDir), JSON.stringify(expected));

// Check extension-page messages even when Chromium supplies sender.tab.
let onMessage, onAction;
const extensionUrl = "chrome-extension://test-extension/";
const fakeChrome = {
  runtime: {id: "test-extension", getURL: (path) => extensionUrl + path, onMessage: {addListener: (fn) => { onMessage = fn; }}},
  action: {onClicked: {addListener: (fn) => { onAction = fn; }}},
  tabs: {
    onRemoved: {addListener() {}}, onUpdated: {addListener() {}},
    create: async (options) => { fakeChrome.lastCreated = options; },
    sendMessage: async (tabId) => {
      onMessage({type: "PBT_FRAME_READY"}, {id: "test-extension", url: "https://school.panopto.com/Panopto/Pages/Sessions/List.aspx?secret=do-not-store", tab: {id: tabId}, frameId: 3}, () => {});
    }
  }
};
vm.runInNewContext(fs.readFileSync(new URL("./background.js", import.meta.url), "utf8"), {
  chrome: fakeChrome, Map, URL, Date, setTimeout: (fn) => { queueMicrotask(fn); }
});
const discovered = await new Promise((resolve) => {
  const keepAlive = onMessage({type: "PBT_DISCOVER", tabId: 9}, {id: "test-extension", url: extensionUrl + "dashboard.html", tab: {id: 12}}, resolve);
  assert.equal(keepAlive, true);
});
assert.equal(discovered.frames.length, 1);
assert.equal(discovered.frames[0].frameId, 3);
assert.equal(discovered.frames[0].path, "/Panopto/Pages/Sessions/List.aspx");
assert.ok(!JSON.stringify(discovered).includes("do-not-store"));
let foreignResponse = false;
onMessage({type: "PBT_DISCOVER", tabId: 9}, {id: "test-extension", url: "https://school.panopto.com/Panopto/Pages/Viewer.aspx", tab: {id: 9}}, () => { foreignResponse = true; });
assert.equal(foreignResponse, false);
await onAction({id: 9});
assert.equal(fakeChrome.lastCreated.url, extensionUrl + "dashboard.html?sourceTab=9");
// The same toolbar action switches to the overview only on a Canvas dashboard.
fakeChrome.scripting = {executeScript: async ({target, func}) => {
  assert.equal(target.tabId, 9);
  return [{result: vm.runInNewContext(`(${func.toString()})()`, {
    location: {protocol: "https:", pathname: "/"},
    document: {querySelector: () => ({})}
  })}];
}};
await onAction({id: 9});
assert.equal(fakeChrome.lastCreated.url, extensionUrl + "courses.html?sourceTab=9");
for (const [pathname, protocol, hasMarker] of [["/courses/123", "https:", true], ["/", "https:", false], ["/", "http:", true]]) {
  fakeChrome.scripting.executeScript = async ({func}) => [{result: vm.runInNewContext(`(${func.toString()})()`, {
    location: {protocol, pathname}, document: {querySelector: () => hasMarker ? {} : null}
  })}];
  await onAction({id: 9});
  assert.equal(fakeChrome.lastCreated.url, extensionUrl + "dashboard.html?sourceTab=9");
}

const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.ok(!manifest.permissions.includes("cookies"));
assert.ok(!manifest.permissions.includes("history"));
assert.ok(!manifest.host_permissions.includes("<all_urls>"));
for (const script of manifest.content_scripts.flatMap((entry) => entry.js)) assert.ok(fs.existsSync(new URL(script, import.meta.url)));
const source = fs.readFileSync(new URL("./dashboard.js", import.meta.url), "utf8");
assert.ok(source.includes("url: launch.href"));
const exportBlock = source.slice(source.indexOf("async function saveResults()"), source.indexOf("async function run(mode)"));
assert.ok(!exportBlock.includes("launchUrl"), "Launch URLs must never enter saved files");
console.log("core: transcript conversion, ZIP structure, messaging, and export privacy checks passed");
