export function decodeEntities(value) {
  const named = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "};
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export function cleanCaption(value) {
  return decodeEntities(String(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:b|i|u|font|span|c|v|ruby|rt)(?:\.[^\s>]+|\s[^>]*)?>/gi, ""))
    .replace(/\r\n?/g, "\n").trim();
}

function timestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function cuesToSrt(cues) {
  if (!cues.length || cues.some((cue) => !Number.isFinite(cue.start) || !Number.isFinite(cue.duration) || cue.duration < 0)) return null;
  return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.start + cue.duration)}\n${cleanCaption(cue.text)}\n`).join("\n");
}

export function cuesToText(cues) {
  // Preserve all caption words and repeated phrases. No AI rewriting/deduplication.
  const paragraphs = [];
  let current = "";
  let previousEnd = null;
  for (const cue of cues) {
    const text = cleanCaption(cue.text);
    if (!text) continue;
    const gap = Number.isFinite(cue.start) && previousEnd !== null ? cue.start - previousEnd : 0;
    if (current && (gap >= 5 || (current.length >= 650 && /[.!?。！？]["”’']?$/.test(current)))) {
      paragraphs.push(current);
      current = "";
    }
    const noSpace = /[\u3400-\u9fff]$/.test(current) && /^[\u3400-\u9fff]/.test(text);
    current += (current && !noSpace ? " " : "") + text;
    previousEnd = Number.isFinite(cue.start) && Number.isFinite(cue.duration) ? cue.start + cue.duration : null;
  }
  if (current) paragraphs.push(current);
  return paragraphs.join("\n\n") + "\n";
}

export function srtToText(raw) {
  const blocks = String(raw).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((line) => /\d+:\d{2}:\d{2}[,.]\d+\s*-->/.test(line));
    if (timeIndex < 0) continue;
    const text = cleanCaption(lines.slice(timeIndex + 1).join("\n"));
    if (text) cues.push({text});
  }
  return cues.length ? cuesToText(cues) : null;
}

export function safeFilename(value, maxLength = 115) {
  const clean = String(value || "未命名讲座").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ").replace(/[ .]+$/g, "").trim();
  let name = Array.from(clean || "未命名讲座").slice(0, maxLength).join("").replace(/[ .]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
  return name || "未命名讲座";
}

export function csvCell(value) {
  let text = String(value ?? "");
  // Prevent spreadsheet formula interpretation of website-provided titles.
  if (/^[\s\uFEFF]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
