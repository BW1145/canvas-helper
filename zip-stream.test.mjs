import assert from "node:assert/strict";
import {test} from "node:test";
import fs from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {StreamingZipWriter} from "./zip.js";

const bytes = (value) => new TextEncoder().encode(value);

// Small in-memory test sink only; production sinks write straight to disk.
class MemoryFile {
  data = new Uint8Array();
}
class MemorySink {
  constructor(file = new MemoryFile()) {
    this.file = file;
    this.position = 0;
    this.closed = false;
    this.failNextWrite = false;
    this.failClose = false;
  }
  async write(chunk) {
    assert.equal(this.closed, false);
    const end = this.position + chunk.length;
    if (this.file.data.length < end) {
      const expanded = new Uint8Array(end);
      expanded.set(this.file.data);
      this.file.data = expanded;
    }
    this.file.data.set(chunk, this.position);
    this.position = end;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated write failure after bytes reached disk");
    }
  }
  async seek(position) { this.position = position; }
  async truncate(size) {
    this.file.data = this.file.data.slice(0, size);
    this.position = Math.min(this.position, size);
  }
  async close() {
    if (this.failClose) throw new Error("simulated commit failure");
    this.closed = true;
  }
  async abort() { this.closed = true; }
}

class FileSink {
  constructor(handle) { this.handle = handle; this.position = 0; }
  async write(chunk) {
    let written = 0;
    while (written < chunk.length) {
      const result = await this.handle.write(chunk, written, chunk.length - written, this.position);
      if (!result.bytesWritten) throw new Error("zero-byte file write");
      written += result.bytesWritten;
      this.position += result.bytesWritten;
    }
  }
  async seek(position) { this.position = position; }
  async truncate(size) { await this.handle.truncate(size); this.position = Math.min(this.position, size); }
  async close() { await this.handle.close(); }
  async abort() { await this.handle.close(); }
}

function checkArchive(data, expected) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const locator = data.length - 22 - 20;
  assert.equal(view.getUint32(locator, true), 0x07064b50);
  const zip64 = Number(view.getBigUint64(locator + 8, true));
  assert.equal(view.getUint32(zip64, true), 0x06064b50);
  const count = Number(view.getBigUint64(zip64 + 32, true));
  assert.equal(count, Object.keys(expected).length);
  let position = Number(view.getBigUint64(zip64 + 48, true));
  const names = [];
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(position, true), 0x02014b50);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const name = new TextDecoder().decode(data.subarray(position + 46, position + 46 + nameLength));
    names.push(name);
    const extra = position + 46 + nameLength;
    const size = Number(view.getBigUint64(extra + 4, true));
    const local = Number(view.getBigUint64(extra + 20, true));
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const payload = data.subarray(start, start + size);
    assert.deepEqual(Buffer.from(payload), Buffer.from(expected[name], "base64"));
    // Independent bitwise reference CRC (no writer's lookup table).
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, view.getUint32(position + 16, true));
    const descriptor = start + size;
    assert.equal(view.getUint32(descriptor, true), 0x08074b50);
    assert.equal(view.getBigUint64(descriptor + 8, true), BigInt(size));
    position += 46 + nameLength + extraLength + view.getUint16(position + 32, true);
  }
  assert.deepEqual(names, Object.keys(expected));
  assert.ok(names.every((name) => !name.includes("/")));
}

test("real ZIP64 file: stream video, reopen, replace text/checklist, verify bytes and CRC", async () => {
  const directory = new URL("../test-output/", import.meta.url);
  await fs.mkdir(directory, {recursive: true});
  const path = fileURLToPath(new URL("fixture-stream-transcripts-video.zip", directory));
  const expectedPath = fileURLToPath(new URL("fixture-stream-expected.json", directory));
  const video = Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 1, 2, 3, 4]);
  const transcript = "音乐讲座\nKia ora & welcome.\n";
  const checklist = "\uFEFF讲座,文件,状态\r\n音乐讲座,001_音乐.mp4,成功\r\n";
  const writer = new StreamingZipWriter(new FileSink(await fs.open(path, "w+")), new Date("2026-10-18T00:00:00Z"));
  const progress = [];
  const result = await writer.add("001_音乐.mp4", (async function* () {
    yield video.subarray(0, 7);
    yield video.subarray(7, 12);
    yield video.subarray(12);
  })(), {onProgress: (count) => progress.push(count)});
  assert.deepEqual(progress, [7, 12, 20]);
  assert.equal(result.size, video.length);
  const checkpoint = writer.checkpoint();
  await writer.add("001_音乐.txt", "OLD TRANSCRIPT");
  await writer.add("下载清单.csv", "OLD CHECKLIST");
  await writer.close();
  await writer.resume(new FileSink(await fs.open(path, "r+")), checkpoint);
  assert.deepEqual(writer.checkpoint(), checkpoint);
  await writer.add("001_音乐.txt", transcript);
  await writer.add("下载清单.csv", new Blob([checklist]));
  await writer.close();
  const expected = {"001_音乐.mp4": Buffer.from(video).toString("base64"),
    "001_音乐.txt": Buffer.from(transcript).toString("base64"),
    "下载清单.csv": Buffer.from(checklist).toString("base64")};
  await fs.writeFile(expectedPath, JSON.stringify(expected));
  checkArchive(await fs.readFile(path), expected);
});

test("aborting an entry rolls back all its bytes and keeps earlier entries", async () => {
  const sink = new MemorySink();
  const writer = new StreamingZipWriter(sink);
  await writer.add("keep.txt", "preserved");
  const checkpoint = writer.checkpoint();
  const prefix = sink.file.data.slice();
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    start(streamController) { streamController.enqueue(bytes("partial video")); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(writer.add("bad.mp4", stream, {
    signal: controller.signal,
    onProgress() { controller.abort(); }
  }), {name: "AbortError"});
  assert.equal(cancelled, true);
  assert.deepEqual(writer.checkpoint(), checkpoint);
  assert.deepEqual(sink.file.data, prefix);
  assert.equal(sink.position, checkpoint.offset);
  await writer.add("下载清单.csv", "cancelled video");
  await writer.close();
});

test("abort interrupts an unresolved stream read and cancels its source", {timeout: 2000}, async () => {
  const writer = new StreamingZipWriter(new MemorySink());
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    pull() { setTimeout(() => controller.abort(), 0); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(writer.add("waiting.mp4", stream, {signal: controller.signal}), {name: "AbortError"});
  assert.equal(cancelled, true);
  assert.deepEqual(writer.checkpoint(), {entries: 0, offset: 0});
});

test("source failure and a partial sink write both roll back before continuing", async () => {
  const sink = new MemorySink();
  const writer = new StreamingZipWriter(sink);
  await writer.add("keep.txt", "original");
  const checkpoint = writer.checkpoint();
  const prefix = sink.file.data.slice();
  await assert.rejects(writer.add("broken.mp4", (async function* () {
    yield bytes("first chunk");
    throw new Error("network failed");
  })()), /network failed/);
  assert.deepEqual(writer.checkpoint(), checkpoint);
  assert.deepEqual(sink.file.data, prefix);
  sink.failNextWrite = true;
  await assert.rejects(writer.add("failed.txt", "partial write"), /simulated write failure/);
  assert.deepEqual(sink.file.data, prefix);
  assert.deepEqual(writer.checkpoint(), checkpoint);
  await writer.add("new.txt", "after retry");
  await writer.close();
});

test("failed close retains metadata and can be reopened at its content checkpoint", async () => {
  const sink = new MemorySink();
  const writer = new StreamingZipWriter(sink);
  await writer.add("001.mp4", Uint8Array.from([1, 2, 3]));
  const checkpoint = writer.checkpoint();
  sink.failClose = true;
  await assert.rejects(writer.close(), /simulated commit failure/);
  assert.equal(writer.needsResume, true);
  assert.deepEqual(writer.checkpoint(), checkpoint);
  assert.ok(sink.file.data.length > checkpoint.offset);
  const reopened = new MemorySink(sink.file);
  await writer.resume(reopened, checkpoint);
  assert.equal(writer.needsResume, false);
  assert.equal(sink.file.data.length, checkpoint.offset);
  await writer.close();
  assert.equal(reopened.closed, true);
});

test("invalid checkpoint is rejected before truncating the file", async () => {
  const sink = new MemorySink();
  const writer = new StreamingZipWriter(sink);
  await writer.add("keep.txt", "preserve");
  const original = sink.file.data.slice();
  const checkpoint = writer.checkpoint();
  await assert.rejects(writer.resume(sink, {...checkpoint, offset: checkpoint.offset - 1}), /检查点/);
  assert.deepEqual(sink.file.data, original);
});

test("ZIP64 keeps offsets beyond 4 GiB without integer truncation (sparse virtual sink)", async () => {
  const writes = [];
  const sink = {
    position: 0,
    async write(chunk) { writes.push({offset: this.position, data: chunk.slice()}); this.position += chunk.length; },
    async seek(value) { this.position = value; },
    async truncate() {},
    async close() {}
  };
  const writer = new StreamingZipWriter(sink);
  // Model a previously written large prefix without allocating its video body.
  const largeOffset = 0x100000000 + 123;
  sink.position = largeOffset;
  writer.offset = largeOffset;
  writer._contentOffset = largeOffset;
  const entry = await writer.add("tail.txt", "tail");
  assert.equal(entry.offset, largeOffset);
  const checkpoint = writer.checkpoint();
  await writer.close();
  const signature = (chunk) => chunk.data.length >= 4 ? new DataView(chunk.data.buffer).getUint32(0, true) : 0;
  const centralIndex = writes.findIndex((chunk) => signature(chunk) === 0x02014b50);
  const central = new DataView(writes[centralIndex].data.buffer);
  assert.equal(central.getUint32(42, true), 0xffffffff);
  const extra = new DataView(writes[centralIndex + 2].data.buffer);
  assert.equal(extra.getBigUint64(20, true), BigInt(largeOffset));
  const ending = writes.find((chunk) => signature(chunk) === 0x06064b50);
  const end = new DataView(ending.data.buffer);
  assert.equal(end.getBigUint64(48, true), BigInt(checkpoint.offset));
  const locator = new DataView(writes.find((chunk) => signature(chunk) === 0x07064b50).data.buffer);
  assert.equal(locator.getBigUint64(8, true), BigInt(ending.offset));
  assert.ok(sink.position > 0x100000000);
});
