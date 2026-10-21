import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {makeZip, StreamingZipWriter} from './zip.js';
import {cuesToText, srtToText, safeFilename, csvCell} from './transcript-utils.js';

// Run the actual coordinator and ZIP writer; only browser/network boundaries
// are fixtures. File writes become visible only after a successful close.
const source = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const script = source.slice(0, source.indexOf('$("primaryBtn").addEventListener')).replace(/^import .*;\n/gm, '');
const signedUrl = 'https://media.example.invalid/lecture.mp4?signature=fixture-secret';
const videoBytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0, ...Array.from({length: 1200}, (_, i) => (i * 17) % 256)]);

function lecture(index, extra = {}) {
  const id = `${index.toString(16).padStart(8, '0')}-1111-4222-8333-444444444444`;
  return {id, key: `https://example.panopto.com/${id}`, title: `讲座 ${index}`, url: `https://example.panopto.com/Panopto/Pages/Viewer.aspx?id=${id}`,
    launchUrl: `https://example.panopto.com/Panopto/Pages/Viewer.aspx?id=${id}&auth=fixture-secret`,
    origin: 'https://example.panopto.com', status: 'pending', error: '', code: '', data: null, ...extra};
}
function byteStream(chunks) {
  const pending = [...chunks];
  return new ReadableStream({pull(controller) {
    if (pending.length) controller.enqueue(pending.shift()); else controller.close();
  }}, {highWaterMark: 0});
}
function archiveFiles(input) {
  const bytes = Buffer.from(input), end = bytes.length - 22;
  assert.ok(end >= 0);
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'complete archive end record');
  let count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = end - 20;
    assert.equal(bytes.readUInt32LE(locator), 0x07064b50);
    const zip64 = Number(bytes.readBigUInt64LE(locator + 8));
    assert.equal(bytes.readUInt32LE(zip64), 0x06064b50);
    count = Number(bytes.readBigUInt64LE(zip64 + 32)); offset = Number(bytes.readBigUInt64LE(zip64 + 48));
  }
  const files = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 10), 0, 'stored entry');
    const n = bytes.readUInt16LE(offset + 28), x = bytes.readUInt16LE(offset + 30), c = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + n).toString('utf8');
    let size = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20), local = bytes.readUInt32LE(offset + 42);
    for (let extra = offset + 46 + n; extra < offset + 46 + n + x;) {
      const kind = bytes.readUInt16LE(extra), length = bytes.readUInt16LE(extra + 2);
      if (kind === 1) {
        let field = extra + 4;
        if (size === 0xffffffff) {size = Number(bytes.readBigUInt64LE(field)); field += 8;}
        if (compressed === 0xffffffff) {compressed = Number(bytes.readBigUInt64LE(field)); field += 8;}
        if (local === 0xffffffff) local = Number(bytes.readBigUInt64LE(field));
      }
      extra += 4 + length;
    }
    assert.equal(size, compressed);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.ok(start + size <= offset);
    assert.equal(files.has(name), false, `duplicate archive entry: ${name}`);
    files.set(name, bytes.subarray(start, start + size)); offset += 46 + n + x + c;
  }
  return files;
}

class FileHandleFixture {
  constructor(trace, options) {
    this.name = options.fileName || '我自己选择的课程合集.zip';
    this.committed = Buffer.alloc(0); this.commits = []; this.createCalls = []; this.sinks = []; this.failCloses = 0; this.trace = trace;
  }
  async createWritable({keepExistingData} = {}) {
    this.trace.push('open-file');
    assert.ok(this.sinks.every(sink => sink.finished), 'no simultaneous writable handles');
    this.createCalls.push({keepExistingData});
    let temp = keepExistingData ? Buffer.from(this.committed) : Buffer.alloc(0), cursor = 0;
    const owner = this;
    const sink = {
      finished: false, writes: [], truncates: [], aborted: false,
      async write(bytes) {
        assert.equal(this.finished, false);
        const data = Buffer.from(bytes); this.writes.push(data);
        if (cursor + data.length > temp.length) {const expanded = Buffer.alloc(cursor + data.length); temp.copy(expanded); temp = expanded;}
        data.copy(temp, cursor); cursor += data.length;
      },
      async seek(position) {assert.equal(this.finished, false); assert.ok(Number.isSafeInteger(position) && position >= 0); cursor = position;},
      async truncate(size) {
        assert.equal(this.finished, false); this.truncates.push({before: temp.length, after: size});
        const resized = Buffer.alloc(size); temp.copy(resized); temp = resized;
      },
      async close() {
        assert.equal(this.finished, false); owner.trace.push('close-file');
        if (owner.failCloses > 0) {owner.failCloses--; throw new Error('Fixture close failed');}
        owner.committed = Buffer.from(temp); owner.commits.push(owner.committed); this.finished = true;
      },
      async abort() {this.aborted = true; this.finished = true; owner.trace.push('abort-file');}
    };
    this.sinks.push(sink); return sink;
  }
}

function harness(options = {}) {
  const blobs = [], downloads = [], messages = [], assetCalls = [], videoCalls = [], permissionCalls = [], trace = [], pickerCalls = [];
  const controls = new Map(), handle = new FileHandleFixture(trace, options);
  let api;
  const document = {activeElement: null};
  function element(tag) {
    return {tag, children: [], dataset: {}, events: {}, attributes: {}, textContent: '',
      setAttribute(name, value) {this.attributes[name] = value;},
      addEventListener(name, handler) {this.events[name] = handler;},
      append(...nodes) {this.children.push(...nodes.flatMap(node => node.tag === '#fragment' ? node.children : [node]));},
      replaceChildren(...nodes) {this.children = []; this.append(...nodes);},
      focus() {document.activeElement = this;}
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) controls.set(id, element('control'));
  document.getElementById = id => controls.get(id); document.createElement = element; document.createDocumentFragment = () => element('#fragment');
  class MockURL extends URL {static createObjectURL(blob) {blobs.push(blob); return `blob:fixture-${blobs.length}`;}}
  const context = {
    URL: MockURL, location: {href: 'chrome-extension://fixture/dashboard.html?sourceTab=1'}, document,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, ReadableStream, AbortController, DOMException,
    cuesToText, srtToText, safeFilename, csvCell, makeZip, StreamingZipWriter,
    setTimeout(callback) {queueMicrotask(callback); return 1;},
    fixtureStatus(message) {messages.push(message);}, fixtureRender() {},
    async fixtureSource() {return options.scanSource(api);},
    async fixtureAsset(row, asset = 'transcript') {
      trace.push(`asset-${asset}`); assetCalls.push([row.id, asset]);
      if (options.asset) return options.asset(row, asset, api);
      return asset === 'video' ? {ok: true, kind: 'video', url: signedUrl, format: 'mp4'}
        : {ok: true, kind: 'text', text: `讲座 ${row.id} 的原文。重复，重复。\n`, language: '中文'};
    },
    async fetchVideoStream(url, {signal}) {
      trace.push('video-fetch'); videoCalls.push({url, signal});
      if (options.videoStream) return options.videoStream({url, signal, api, call: videoCalls.length});
      return {stream: byteStream([videoBytes.subarray(0, 600), videoBytes.subarray(600)]), totalBytes: videoBytes.length};
    },
    window: {showSaveFilePicker(request) {
      trace.push('picker'); pickerCalls.push(request);
      return options.cancelPicker ? Promise.reject(new DOMException('Cancelled', 'AbortError')) : Promise.resolve(handle);
    }},
    chrome: {
      tabs: {remove: async () => {}, update: async () => {}, get: async () => ({title: '测试课程'}),
        sendMessage: async (...args) => options.nextPage(...args)},
      permissions: {request(request) {
        trace.push('permission'); permissionCalls.push({origins: [...request.origins]});
        return Promise.resolve(options.permission ? options.permission(request) : true);
      }},
      downloads: {
        async download(request) {
          trace.push('download'); downloads.push(request);
          assert.match(request.url, /^blob:/, 'chrome.downloads only handles a small transcript ZIP'); return 1000 + blobs.length;
        },
        async search({id}) {return [{id, state: 'complete'}];}
      }
    }
  };
  vm.runInNewContext(script + `
    const renderGrid = render;
    render = fixtureRender; status = fixtureStatus; log = fixtureStatus; getAsset = fixtureAsset;
    ${options.scanSource ? 'getSourceFrame = fixtureSource;' : ''}
    globalThis.testApi = {state, renderGrid, run, saveResults};
  `, context);
  api = context.testApi;
  Object.assign(api.state, {courseTitle: '测试课程', sourceFrame: {tabId: 1, frameId: 0, origin: 'https://example.panopto.com'},
    includeVideo: Boolean(options.video), rows: options.rows || [lecture(1)]});
  api.state.selected = new Set(api.state.rows.map(row => row.key)); controls.get('includeVideo').checked = api.state.includeVideo;
  return {api, blobs, downloads, messages, assetCalls, videoCalls, permissionCalls, trace, pickerCalls, handle, controls, document,
    async files() {return archiveFiles(api.state.archive ? handle.committed : await blobs.at(-1).arrayBuffer());}};
}
function namesWith(files, suffix) {return [...files.keys()].filter(name => name.endsWith(suffix));}
function checkOutput(files) {
  assert.equal(namesWith(files, '.csv').length, 1); assert.ok(files.has('下载清单.csv'));
  assert.ok([...files.keys()].every(name => !/[\\/]/.test(name)), 'all files share the archive root');
  assert.ok(files.get('下载清单.csv').subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  for (const [name, bytes] of files) if (/\.(?:csv|txt)$/.test(name)) assert.doesNotMatch(bytes.toString('utf8'), /fixture-secret|signature=|auth=|media\.example|C:\/Users/);
}

test('default run saves only TXT and one CSV, with no video fetch', async () => {
  const h = harness({rows: [lecture(1), lecture(2)], asset(row) {
    return row.id.startsWith('00000002') ? {ok: false, code: 'NO_CAPTIONS', message: '未找到转录稿。'}
      : {ok: true, kind: 'srt', language: 'English', raw: '1\n00:00:00,000 --> 00:00:02,000\nKeep every word.\n\n2\n00:00:03,000 --> 00:00:04,000\nRepeat, repeat.\n'};
  }});
  await h.api.run('selected');
  const files = await h.files(); checkOutput(files);
  assert.equal(files.size, 2); assert.equal(namesWith(files, '.txt').length, 1);
  assert.match(files.get(namesWith(files, '.txt')[0]).toString('utf8'), /Keep every word\. Repeat, repeat\./);
  assert.equal(h.videoCalls.length, 0); assert.equal(h.pickerCalls.length, 0); assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].saveAs, true);
});

test('video run writes video bytes, TXT and one CSV into the chosen ZIP, even without captions', async () => {
  const h = harness({video: true, rows: [lecture(1), lecture(2)], asset(row, asset) {
    if (asset === 'video') return {ok: true, kind: 'video', url: signedUrl, format: 'mp4'};
    return row.id.startsWith('00000002') ? {ok: false, code: 'NO_CAPTIONS', message: '未找到转录稿。'} : {ok: true, kind: 'text', text: '完整原文。重复，重复。\n', language: '中文'};
  }});
  await h.api.run('selected');
  const files = await h.files(); checkOutput(files);
  assert.equal(files.size, 4); assert.equal(namesWith(files, '.txt').length, 1); assert.equal(namesWith(files, '.mp4').length, 2);
  for (const name of namesWith(files, '.mp4')) assert.deepEqual(files.get(name), videoBytes);
  assert.deepEqual(h.api.state.rows.map(row => row.video.status), ['success', 'success']); assert.equal(h.api.state.rows[1].status, 'error');
  const csv = files.get('下载清单.csv').toString('utf8');
  assert.match(csv, /视频文件.*视频状态.*视频原因/); assert.match(csv, /未找到转录稿/); assert.equal((csv.match(/已写入下载包/g) || []).length, 2);
  assert.equal(h.pickerCalls.length, 1); assert.equal(h.api.state.archive.handle, h.handle); assert.equal(h.handle.name, '我自己选择的课程合集.zip');
  assert.equal(h.downloads.length, 0); assert.equal(h.trace[0], 'picker'); assert.ok(h.messages.some(message => message.includes(h.handle.name)));
  const out = fileURLToPath(new URL('../test-output/', import.meta.url)); mkdirSync(out, {recursive: true});
  writeFileSync(out + '/fixture-unified-dashboard.zip', h.handle.committed);
  writeFileSync(out + '/fixture-unified-dashboard-expected.json', JSON.stringify({names: [...files.keys()], videoHex: videoBytes.toString('hex')}, null, 2));
});

test('retry reuses the same file, skips finished assets and replaces the CSV tail', async () => {
  let allowSecond = false;
  const h = harness({video: true, rows: [lecture(1), lecture(2)], asset(row, asset) {
    if (asset === 'transcript') return {ok: true, kind: 'text', text: '原文。\n'};
    if (!allowSecond && row.id.startsWith('00000002')) return {ok: false, code: 'NO_VIDEO_DOWNLOAD', message: '暂未提供视频。'};
    return {ok: true, kind: 'video', url: signedUrl};
  }});
  await h.api.run('selected');
  const before = h.assetCalls.length, oldBytes = Buffer.from(h.handle.committed); allowSecond = true;
  await h.api.run('retry');
  const files = await h.files(); checkOutput(files);
  assert.equal(h.assetCalls.length - before, 1); assert.equal(h.videoCalls.length, 2); assert.equal(h.pickerCalls.length, 1);
  assert.deepEqual(h.handle.createCalls, [{keepExistingData: false}, {keepExistingData: true}]); assert.equal(h.handle.commits.length, 2);
  assert.notDeepEqual(h.handle.committed, oldBytes); assert.equal(files.size, 5); assert.equal(namesWith(files, '.mp4').length, 2);
  assert.doesNotMatch(files.get('下载清单.csv').toString('utf8'), /暂未提供视频/);
});

test('stop rolls back the partial video and finally commits a valid same-file archive', async () => {
  const h = harness({video: true, rows: [lecture(1), lecture(2), lecture(3)], videoStream({api, call}) {
    if (call === 1) return {stream: byteStream([videoBytes]), totalBytes: videoBytes.length};
    let pulls = 0;
    return {totalBytes: videoBytes.length, stream: new ReadableStream({pull(controller) {
      if (++pulls === 1) controller.enqueue(videoBytes.subarray(0, 600)); else {api.state.cancelled = true; api.state.activeVideoController.abort();}
    }}, {highWaterMark: 0})};
  }});
  await h.api.run('selected');
  const files = await h.files(); checkOutput(files);
  assert.equal(h.videoCalls.length, 2); assert.equal(namesWith(files, '.mp4').length, 1); assert.equal(namesWith(files, '.txt').length, 2);
  assert.deepEqual(files.get(namesWith(files, '.mp4')[0]), videoBytes);
  assert.equal(h.api.state.rows[1].video.status, 'pending'); assert.equal(h.api.state.rows[2].status, 'pending');
  assert.equal(h.api.state.activeVideoController, null); assert.equal(h.api.state.archive.active, false); assert.equal(h.handle.commits.length, 1);
  assert.ok(h.handle.sinks[0].truncates.some(change => change.before - change.after >= 600), 'partly written video bytes were rolled back');
  assert.match(files.get('下载清单.csv').toString('utf8'), /已停止/); assert.ok(h.messages.at(-1).includes('已停止'));
});

test('failed close retains the previous file, rolls back uncommitted success and allows retry', async () => {
  let allowSecond = false;
  const h = harness({video: true, rows: [lecture(1), lecture(2)], asset(row, asset) {
    if (asset === 'transcript') return {ok: true, kind: 'text', text: '原文。\n'};
    if (!allowSecond && row.id.startsWith('00000002')) return {ok: false, code: 'NO_VIDEO_DOWNLOAD', message: '稍后重试。'};
    return {ok: true, kind: 'video', url: signedUrl};
  }});
  await h.api.run('selected'); const committed = Buffer.from(h.handle.committed); allowSecond = true; h.handle.failCloses = 1;
  await h.api.run('retry');
  assert.deepEqual(h.handle.committed, committed); assert.equal(h.api.state.rows[0].video.status, 'success');
  assert.equal(h.api.state.rows[1].video.status, 'error'); assert.equal(h.api.state.rows[1].video.code, 'OUTPUT_WRITE_FAILED');
  assert.equal(h.api.state.archive.saveFailed, true); assert.equal(h.handle.sinks[1].aborted, true); assert.equal(h.handle.commits.length, 1);
  assert.equal(namesWith(await h.files(), '.mp4').length, 1);
  await h.api.run('retry');
  const files = await h.files(); checkOutput(files);
  assert.equal(namesWith(files, '.mp4').length, 2); assert.ok(h.api.state.rows.every(row => row.video.status === 'success'));
  assert.equal(h.api.state.archive.saveFailed, false); assert.equal(h.videoCalls.length, 3); assert.equal(h.pickerCalls.length, 1);
  assert.deepEqual(h.handle.createCalls.map(call => call.keepExistingData), [false, true, true]);
});

test('cancelling the save picker performs no file, asset or video work', async () => {
  const h = harness({video: true, cancelPicker: true}); await h.api.run('selected');
  assert.equal(h.pickerCalls.length, 1); assert.equal(h.assetCalls.length, 0); assert.equal(h.videoCalls.length, 0); assert.equal(h.handle.createCalls.length, 0);
  assert.equal(h.downloads.length, 0); assert.equal(h.api.state.archive, null); assert.equal(h.api.state.busy, false);
});

test('retry requests only the missing origin before async work and reuses its file handle', async () => {
  let allowed = false; const permissionOrigin = 'https://media.example.invalid/*';
  const h = harness({video: true, permission() {allowed = true; return true;}, videoStream() {
    if (!allowed) throw Object.assign(new Error('需要授权。'), {code: 'VIDEO_HOST_PERMISSION', permissionOrigin});
    return {stream: byteStream([videoBytes]), totalBytes: videoBytes.length};
  }});
  await h.api.run('selected');
  assert.equal(h.api.state.rows[0].video.code, 'VIDEO_HOST_PERMISSION'); assert.equal(h.permissionCalls.length, 0); assert.equal(h.handle.commits.length, 1);
  const traceStart = h.trace.length; await h.api.run('retry');
  assert.equal(h.trace[traceStart], 'permission'); assert.deepEqual(h.permissionCalls, [{origins: [permissionOrigin]}]);
  assert.equal(h.pickerCalls.length, 1); assert.equal(h.handle.createCalls.length, 2); assert.equal(h.api.state.archive.handle, h.handle);
  assert.equal(h.api.state.rows[0].video.status, 'success'); assert.equal(namesWith(await h.files(), '.mp4').length, 1);
});

test('split HTML, empty streams and incomplete bytes never become video entries', async () => {
  const cases = [
    {chunks: ['  <', '!DOC', 'TYPE html><html>login</html>'].map(text => Buffer.from(text)), totalBytes: null, code: 'VIDEO_NOT_MEDIA'},
    {chunks: [], totalBytes: null, code: 'EMPTY_VIDEO'},
    {chunks: [videoBytes.subarray(0, 700)], totalBytes: videoBytes.length, code: 'INCOMPLETE_VIDEO'}
  ];
  for (const item of cases) {
    const h = harness({video: true, videoStream: () => ({stream: byteStream(item.chunks), totalBytes: item.totalBytes})}); await h.api.run('selected');
    const files = await h.files(); checkOutput(files);
    assert.equal(namesWith(files, '.mp4').length, 0); assert.equal(files.size, 2); assert.equal(h.api.state.rows[0].video.code, item.code); assert.equal(h.api.state.rows[0].video.status, 'error');
    assert.doesNotMatch(files.get('下载清单.csv').toString('utf8'), /已写入下载包|\.mp4/);
  }
});

test('saving after a changed course retains the original archive and its specific error', async () => {
  const h = harness({video: true}); await h.api.run('selected'); const bytes = Buffer.from(h.handle.committed);
  h.api.state.rows = [lecture(99, {status: 'success', data: {text: '另一门课程。'}})];
  await assert.rejects(h.api.saveResults(), {code: 'ARCHIVE_COURSE_CHANGED'});
  assert.deepEqual(h.handle.committed, bytes); assert.equal(h.handle.createCalls.length, 1); assert.equal(h.handle.sinks[0].aborted, false);
});

test('an interrupted rescan recovers committed later-page assets without duplicating video', async () => {
  let nextPageWorks = false;
  const rows = [lecture(1), lecture(2)];
  const frame = {tabId: 1, frameId: 0, origin: 'https://example.panopto.com'};
  const h = harness({video: true, rows, scanSource() {
    return {frame, scan: {sessions: [rows[0]], pagination: {total: 2, hasNext: true}}};
  }, nextPage() {
    return nextPageWorks ? {ok: true, scan: {sessions: [rows[1]], pagination: {total: 2, hasNext: false}}} : {ok: false, message: 'Fixture page failed'};
  }});
  await h.api.run('selected');
  const calls = h.assetCalls.length;
  const original = Buffer.from(h.handle.committed);
  await h.api.run('scan');
  assert.equal(h.api.state.rows.length, 1, 'failed scan retains its partial visible list');
  assert.deepEqual(h.handle.committed, original, 'scan never alters the saved file');
  nextPageWorks = true;
  await h.api.run('scan');
  assert.equal(h.api.state.rows.length, 2);
  assert.ok(h.api.state.rows.every(row => row.status === 'success' && row.video.status === 'success'));
  await h.api.run('selected');
  const files = await h.files(); checkOutput(files);
  assert.equal(files.size, 5); assert.equal(namesWith(files, '.mp4').length, 2);
  assert.equal(h.assetCalls.length, calls); assert.equal(h.videoCalls.length, 2); assert.equal(h.pickerCalls.length, 1);
});

test('grid renders 40 cards and retains checkbox focus after a selection change', () => {
  const h = harness({rows: Array.from({length: 40}, (_, index) => lecture(index + 1))}); h.api.renderGrid();
  const grid = h.controls.get('sessionsBody'); assert.equal(grid.children.length, 40);
  assert.ok(grid.children.every(card => card.tag === 'article' && card.attributes.role === 'listitem'));
  const input = grid.children[0].children[0].children[0]; input.focus(); input.checked = false; input.events.change({target: input}); h.api.renderGrid();
  assert.equal(h.api.state.selected.size, 39); assert.equal(h.document.activeElement, grid.children[0].children[0].children[0]); assert.equal(h.controls.get('selectAll').indeterminate, true);
});

test('dashboard controls and output settings agree with the HTML', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]); assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of source.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(id), `Missing ${id}`);
  assert.doesNotMatch(source + html, /includeSrt|includeCombined/); assert.match(html, /id="sessionsBody" class="session-grid" role="list"/); assert.match(html, /<input id="includeVideo" type="checkbox">/);
});
