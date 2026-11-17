// src/input/pptxValidate.js — §2 from the PPTX plan: treat the .pptx as untrusted input.
//
// A .pptx is a zip. Nothing in the zip headers is trusted:
//   - entry sizes/counts are re-verified by actually streaming and inflating
//     every entry (counting decompressed bytes, aborting at the cap)
//   - declared sizes are only used as early cheap rejections
//   - nothing is ever extracted to disk
//
// Rejects before any converter is spawned; Converter is never exposed to garbage.
// All limits are named constants, overridable via env vars.

import fs from "node:fs";
import zlib from "node:zlib";

const MB = 1024 * 1024;

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Central limit definitions — override via env, e.g. PPTX_MAX_ENTRIES=500. */
export const LIMITS = {
  maxFileBytes:         () => int("PPTX_MAX_FILE_BYTES", 25 * MB),
  maxTotalUncompressed: () => int("PPTX_MAX_UNCOMPRESSED_BYTES", 200 * MB),
  maxEntries:           () => int("PPTX_MAX_ENTRIES", 1000),
  maxEntryUncompressed: () => int("PPTX_MAX_ENTRY_UNCOMPRESSED", 50 * MB),
  maxEntryRatio:        () => int("PPTX_MAX_ENTRY_RATIO", 100),   // per-entry, only above minRatioCheckBytes
  minRatioCheckBytes:   () => int("PPTX_MIN_RATIO_CHECK_BYTES", 1 * MB),
  maxOverallRatio:      () => int("PPTX_MAX_OVERALL_RATIO", 50),
  maxMediaFiles:        () => int("PPTX_MAX_MEDIA_FILES", 200),
  maxImageDimension:    () => int("PPTX_MAX_IMAGE_PIXELS", 10000),
  maxSlides:            () => int("PPTX_MAX_SLIDES", 25),
};

export class PptxValidationError extends Error {
  constructor(message, rule) {
    super(message);
    this.name = "PptxValidationError";
    this.code = "PPTX_INVALID";
    this.rule = rule;
  }
}

const SIG = { LOCAL: 0x04034b50, CENTRAL: 0x02014b50, EOCD: 0x06054b50 };
const MAX_COMMENT = 0xffff;
const SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/;
const ARCHIVE_EXT_RE = /\.(zip|rar|7z|gz|tgz|tar|bz2|xz|jar|apk|iso|cab|lha|ace)$/i;
const COLLECT_BUFFER_BYTES = 10 * MB; // max bytes buffered in-memory per entry for dimension/visibility checks

const q = (s) => `'${s}'`;

// ─────────────────────────────────────────────────────────────────────────────
// zip structure (central directory based — offsets come from the CD, which we
// cross-check against the local headers, per "zip quilting" mitigation)
// ─────────────────────────────────────────────────────────────────────────────

function findEOCD(tail, tailBase, fileSize) {
  // Scan backwards; the real EOCD is the one whose comment fills exactly to EOF.
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG.EOCD) continue;
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + 22 + commentLen !== tail.length) continue;
    const entriesOnDisk = tail.readUInt16LE(i + 8);
    const totalEntries = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    if (tail.readUInt16LE(i + 4) !== 0 || tail.readUInt16LE(i + 6) !== 0) {
      throw new PptxValidationError("multi-disk archives are not supported", "eocd");
    }
    if (entriesOnDisk !== totalEntries) {
      throw new PptxValidationError("multi-disk archives are not supported", "eocd");
    }
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new PptxValidationError("ZIP64 archives are not supported", "eocd");
    }
    if (cdOffset + cdSize > fileSize) {
      throw new PptxValidationError("corrupt archive: central directory points past end of file", "eocd");
    }
    return { totalEntries, cdSize, cdOffset, eocdOffset: tailBase + i };
  }
  return null;
}

function isDirectoryEntry(name) {
  return name.endsWith("/");
}

function validateEntryName(name, isDir) {
  if (!name || name.includes("\0")) return "empty or NUL-containing entry name";
  if (name.includes("\\")) return `backslash in entry name ${q(name)}`;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return `absolute path in entry name ${q(name)}`;
  const parts = name.split("/");
  for (const seg of parts) {
    if (seg === ".." || seg === ".") return `path traversal in entry name ${q(name)}`;
  }
  if (isDir && (parts.length < 2 || parts[parts.length - 1] !== "")) return `malformed directory entry ${q(name)}`;
  return null;
}

function parseCentralDirectory(cd, limits) {
  const entries = [];
  const seen = new Set();
  let off = 0;
  let totalUncompressed = 0;
  let sumCompressed = 0;

  while (off < cd.length) {
    if (cd.length - off < 46) throw new PptxValidationError("corrupt archive: truncated central directory", "central-dir");
    if (cd.readUInt32LE(off) !== SIG.CENTRAL) throw new PptxValidationError("corrupt archive: bad central directory signature", "central-dir");

    const flags        = cd.readUInt16LE(off + 8);
    const method       = cd.readUInt16LE(off + 10);
    const compSize     = cd.readUInt32LE(off + 20);
    const uncompSize   = cd.readUInt32LE(off + 24);
    const nameLen      = cd.readUInt16LE(off + 28);
    const extraLen     = cd.readUInt16LE(off + 30);
    const commentLen   = cd.readUInt16LE(off + 32);
    const diskNum      = cd.readUInt16LE(off + 34);
    const extAttrs     = cd.readUInt32LE(off + 38);
    const localOffset  = cd.readUInt32LE(off + 42);
    const name         = cd.toString("utf8", off + 46, off + 46 + nameLen);
    const dir          = isDirectoryEntry(name);

    if (diskNum !== 0) throw new PptxValidationError("multi-disk archives are not supported", "central-dir");
    if (flags & 0x0001) throw new PptxValidationError(`encrypted entry ${q(name)} — encrypted PPTX files are not supported`, "encrypted");
    if (flags & 0x0040) throw new PptxValidationError(`strongly-encrypted entry ${q(name)} — not supported`, "encrypted");
    if (method !== 0 && method !== 8) throw new PptxValidationError(`unsupported compression method ${method} in entry ${q(name)} (only stored/deflate are supported)`, "method");

    const nameErr = validateEntryName(name, dir);
    if (nameErr) throw new PptxValidationError(nameErr, "entry-name");
    if (seen.has(name)) throw new PptxValidationError(`duplicate entry ${q(name)} — possible zip-quilting attack`, "duplicate");
    seen.add(name);

    // Symlink / non-regular unix file types (only when unix mode bits are present)
    const unixMode = (extAttrs >>> 16) & 0xffff;
    if (unixMode !== 0) {
      const type = unixMode & 0xf000;
      if (type !== 0x8000 && type !== 0x4000) { // regular file or directory
        throw new PptxValidationError(`special file type (mode ${unixMode.toString(8)}) in entry ${q(name)} — symlinks and devices are not allowed`, "file-type");
      }
    }

    // Declared-size early rejections (actual bytes are verified in the streaming pass)
    if (uncompSize > limits.maxEntryUncompressed) {
      throw new PptxValidationError(`entry ${q(name)} declares ${(uncompSize / MB).toFixed(1)} MB uncompressed (max ${limits.maxEntryUncompressed / MB} MB)`, "entry-size");
    }
    if (uncompSize > limits.minRatioCheckBytes) {
      if (compSize === 0 || uncompSize / compSize > limits.maxEntryRatio) {
        throw new PptxValidationError(`entry ${q(name)} compresses at >${limits.maxEntryRatio}:1 (entries over 1 MB are capped)`, "ratio");
      }
    }

    totalUncompressed += uncompSize;
    sumCompressed += compSize;
    entries.push({ name, flags, method, compSize, uncompSize, localOffset, dir });

    if (entries.length > limits.maxEntries) {
      throw new PptxValidationError(`too many entries in archive (max ${limits.maxEntries})`, "entries");
    }
    off += 46 + nameLen + extraLen + commentLen;
  }

  if (totalUncompressed > limits.maxTotalUncompressed) {
    throw new PptxValidationError(`archive declares ${(totalUncompressed / MB).toFixed(0)} MB uncompressed (max ${limits.maxTotalUncompressed / MB} MB)`, "total-size");
  }

  return { entries, totalUncompressed, sumCompressed, seen };
}

async function verifyLocalHeaders(filePath, entries, cdOffset) {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    let prevEnd = 0;
    for (const e of sorted) {
      const header = Buffer.alloc(30);
      const { bytesRead } = await fh.read(header, 0, 30, e.localOffset);
      if (bytesRead < 30) throw new PptxValidationError(`corrupt archive: local header for ${q(e.name)} is truncated`, "local-header");
      if (header.readUInt32LE(0) !== SIG.LOCAL) throw new PptxValidationError(`corrupt archive: bad local header signature for ${q(e.name)}`, "local-header");
      const nameLen  = header.readUInt16LE(26);
      const extraLen = header.readUInt16LE(28);
      const localComp    = header.readUInt32LE(18);
      const localUncomp  = header.readUInt32LE(22);
      const localNameBuf = Buffer.alloc(nameLen);
      await fh.read(localNameBuf, 0, nameLen, e.localOffset + 30);
      if (localNameBuf.toString("utf8") !== e.name) {
        throw new PptxValidationError(`local header and central directory disagree on ${q(e.name)} — possible zip-quilting attack`, "quilting");
      }
      if (!(e.flags & 0x0008)) { // no data descriptor: local sizes must match the central directory
        if (localComp !== e.compSize || localUncomp !== e.uncompSize) {
          throw new PptxValidationError(`local header and central directory disagree on sizes for ${q(e.name)} — possible zip-quilting attack`, "quilting");
        }
      }
      const dataStart = e.localOffset + 30 + nameLen + extraLen;
      const dataEnd = dataStart + e.compSize;
      if (dataEnd > cdOffset) throw new PptxValidationError(`entry ${q(e.name)} data overlaps the central directory — corrupt archive`, "overlap");
      if (e.localOffset < prevEnd) throw new PptxValidationError(`overlapping entries near ${q(e.name)} — corrupt archive`, "overlap");
      prevEnd = dataEnd;
    }
  } finally {
    await fh.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming pass: inflate every entry while counting actual bytes. Nothing is
// written to disk; on cap violation we throw immediately.
// ─────────────────────────────────────────────────────────────────────────────

async function* decompressedChunks(filePath, entry, dataStart, dataEnd) {
  const source = fs.createReadStream(filePath, { start: dataStart, end: dataEnd - 1 });
  if (entry.method === 0) {
    for await (const chunk of source) yield chunk;
    return;
  }
  const inflater = zlib.createInflateRaw();
  source.pipe(inflater);
  try {
    for await (const chunk of inflater) yield chunk;
  } catch (err) {
    source.destroy();
    throw new PptxValidationError(`entry ${q(entry.name)} failed to inflate (${err.message}) — corrupt archive`, "inflate");
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageDimensions(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), kind: "png" };
  }
  if (buf.length >= 10 && buf.subarray(0, 3).equals(Buffer.from("GIF"))) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), kind: "gif" };
  }
  if (buf.length >= 26 && buf.subarray(0, 2).equals(Buffer.from("BM"))) {
    return { w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)), kind: "bmp" };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).equals(Buffer.from("RIFF")) && buf.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    const chunk = buf.subarray(12, 16).toString("ascii");
    if (chunk === "VP8 " && buf.length >= 30) {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, kind: "webp" };
    }
    if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, kind: "webp" };
    }
    if (chunk === "VP8X" && buf.length >= 30) {
      const w = 1 + buf.readUIntLE(24, 3);
      const h = 1 + buf.readUIntLE(27, 3);
      return { w, h, kind: "webp" };
    }
    return null; // unknown WebP layout — skip dimension check
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: scan for SOF markers (stop at SOS)
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff || marker === 0x00) { i++; continue; }
      if (marker === 0xda) return null; // start of scan — no SOF within this buffer
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        return { w, h, kind: "jpeg" };
      }
      const segLen = buf.readUInt16BE(i + 2);
      i += 2 + (segLen || 2);
    }
    return null;
  }
  return null; // unknown/unverifiable — allowed (plan: check from headers "where possible")
}

function checkSlideVisibility(name, xml) {
  const hidden = /<p:sld\b[^>]*\bshow\s*=\s*["']0["']/i.test(xml);
  const hasContent = /<p:(sp|pic|graphicFrame|grpSp|cxnSp|contentPart)\b/.test(xml);
  return { hidden, empty: !hasContent };
}

/**
 * Validate a .pptx file on disk. Throws PptxValidationError on any violation;
 * returns { slides, entries, mediaFiles } on success (slides = visible, non-empty).
 */
export async function validatePptx(filePath) {
  const limits = {
    maxFileBytes: LIMITS.maxFileBytes(),
    maxTotalUncompressed: LIMITS.maxTotalUncompressed(),
    maxEntries: LIMITS.maxEntries(),
    maxEntryUncompressed: LIMITS.maxEntryUncompressed(),
    maxEntryRatio: LIMITS.maxEntryRatio(),
    minRatioCheckBytes: LIMITS.minRatioCheckBytes(),
    maxOverallRatio: LIMITS.maxOverallRatio(),
    maxMediaFiles: LIMITS.maxMediaFiles(),
    maxImageDimension: LIMITS.maxImageDimension(),
    maxSlides: LIMITS.maxSlides(),
  };

  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new PptxValidationError("input is not a file", "file-type");
  if (stat.size === 0) throw new PptxValidationError("input is empty", "file-type");
  if (stat.size > limits.maxFileBytes) {
    throw new PptxValidationError(`file is ${(stat.size / MB).toFixed(1)} MB — PPTX uploads are capped at ${limits.maxFileBytes / MB} MB`, "file-size");
  }
  if (stat.size < 22) throw new PptxValidationError("file is too small to be a PPTX", "file-size");

  const fh = await fs.promises.open(filePath, "r");
  let entries, totalDeclared, cdOffset;
  try {
    // magic bytes
    const head = Buffer.alloc(4);
    await fh.read(head, 0, 4, 0);
    if (head.readUInt32LE(0) !== SIG.LOCAL) {
      throw new PptxValidationError("not a real PPTX: bad zip signature", "magic");
    }
    // end of central directory
    const tailLen = Math.min(stat.size, 22 + MAX_COMMENT + 22);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, stat.size - tailLen);
    const eocd = findEOCD(tail, stat.size - tailLen, stat.size);
    if (!eocd) throw new PptxValidationError("not a PPTX: end of central directory not found", "eocd");
    if (eocd.totalEntries > limits.maxEntries) {
      throw new PptxValidationError(`too many entries in archive (${eocd.totalEntries}; max ${limits.maxEntries})`, "entries");
    }
    cdOffset = eocd.cdOffset;
    const cd = Buffer.alloc(eocd.cdSize);
    await fh.read(cd, 0, eocd.cdSize, eocd.cdOffset);
    ({ entries, totalUncompressed: totalDeclared } = parseCentralDirectory(cd, limits));
  } finally {
    await fh.close();
  }

  // overall declared ratio guard (declared sizes — cheap early rejection)
  if (limits.maxOverallRatio > 0 && totalDeclared / stat.size > limits.maxOverallRatio) {
    throw new PptxValidationError(`archive declares a ${(totalDeclared / stat.size).toFixed(0)}:1 compression ratio (max ${limits.maxOverallRatio}:1) — looks like a zip bomb`, "ratio");
  }

  // Required PPTX package structure (rejects DOCX/XLSX renamed to .pptx)
  const names = new Set(entries.map((e) => e.name));
  for (const required of ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"]) {
    if (!names.has(required)) {
      throw new PptxValidationError(`not a PPTX package: missing ${q(required)} (renamed generic zip, DOCX or XLSX?)`, "structure");
    }
  }

  // Nested archives anywhere in the package — never recurse
  for (const e of entries) {
    if (ARCHIVE_EXT_RE.test(e.name)) {
      throw new PptxValidationError(`nested archive ${q(e.name)} — archives inside PPTX files are not allowed`, "nested-archive");
    }
  }

  // Media cap
  const mediaFiles = entries.filter((e) => e.name.startsWith("ppt/media/") && !e.dir);
  if (mediaFiles.length > limits.maxMediaFiles) {
    throw new PptxValidationError(`too many media files in deck (${mediaFiles.length}; max ${limits.maxMediaFiles})`, "media");
  }

  // Overlapping entries (local headers re-verified against the central directory)
  await verifyLocalHeaders(filePath, entries, cdOffset);

  // ── Streaming pass: count ACTUAL decompressed bytes ─────────────────────────
  // Reads local headers again to get data ranges (authoritative offsets come
  // from the central directory, which we just cross-checked).
  const fh2 = await fs.promises.open(filePath, "r");
  let globalInflated = 0;
  const slideXml = new Map();   // name → xml string (bounded)
  const mediaBuf = new Map();   // name → first ≤10 MB of image bytes (for dimension checks)
  try {
    for (const e of entries) {
      if (e.dir) continue;
      const header = Buffer.alloc(30);
      await fh2.read(header, 0, 30, e.localOffset);
      const nameLen = header.readUInt16LE(26);
      const extraLen = header.readUInt16LE(28);
      const dataStart = e.localOffset + 30 + nameLen + extraLen;
      const dataEnd = dataStart + e.compSize;
      if (dataEnd > cdOffset) throw new PptxValidationError(`entry ${q(e.name)} data overlaps the central directory`, "overlap");

      const isSlide = SLIDE_RE.test(e.name);
      const isMedia = e.name.startsWith("ppt/media/");
      const collect = isSlide || isMedia;
      const chunks = [];
      let buffered = 0;
      let actual = 0;

      for await (const chunk of decompressedChunks(filePath, e, dataStart, dataEnd)) {
        actual += chunk.length;
        globalInflated += chunk.length;
        if (actual > limits.maxEntryUncompressed || globalInflated > limits.maxTotalUncompressed) {
          throw new PptxValidationError(`entry ${q(e.name)} inflates past the size caps — looks like a zip bomb`, "bomb");
        }
        if (collect && buffered + chunk.length <= COLLECT_BUFFER_BYTES) {
          chunks.push(chunk);
          buffered += chunk.length;
        }
      }

      if (isSlide && actual <= COLLECT_BUFFER_BYTES) {
        slideXml.set(e.name, Buffer.concat(chunks).toString("utf8"));
      }
      if (isMedia && actual <= COLLECT_BUFFER_BYTES) {
        mediaBuf.set(e.name, Buffer.concat(chunks));
      }
    }
  } finally {
    await fh2.close();
  }

  // Image dimension checks (from headers, where verifiable)
  for (const [name, buf] of mediaBuf) {
    const dims = imageDimensions(buf);
    if (dims && (dims.w > limits.maxImageDimension || dims.h > limits.maxImageDimension)) {
      throw new PptxValidationError(`image ${q(name)} is ${dims.w}x${dims.h} pixels (max ${limits.maxImageDimension}x${limits.maxImageDimension})`, "image-dimensions");
    }
  }

  // Slide count: visible + non-empty only; hidden and empty slides are excluded
  const slideNames = entries.map((e) => e.name).filter((n) => SLIDE_RE.test(n));
  if (slideNames.length === 0) {
    throw new PptxValidationError("not a PPTX deck: no slides found under ppt/slides/", "structure");
  }
  let effective = 0;
  let hidden = 0, empty = 0;
  for (const name of slideNames) {
    const xml = slideXml.get(name);
    if (xml === undefined) { effective++; continue; } // too big to inspect — count it
    const v = checkSlideVisibility(name, xml);
    if (v.hidden) { hidden++; continue; }
    if (v.empty) { empty++; continue; }
    effective++;
  }
  if (effective === 0) {
    throw new PptxValidationError("deck has no visible slides (all slides are hidden or empty)", "slides");
  }
  if (effective > limits.maxSlides) {
    throw new PptxValidationError(`deck has ${effective} visible slides (hidden and empty slides not counted) — max is ${limits.maxSlides}. Split the deck or export visible slides to PDF.`, "slides");
  }

  return { slides: effective, entries: entries.length, mediaFiles: mediaFiles.length, hidden, empty };
}
