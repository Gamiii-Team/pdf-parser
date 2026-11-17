// tests/helpers/zipBuilder.mjs — minimal zip writer for adversarial fixtures.
// Supports just enough control to build deliberately-corrupt .pptx files in tests:
// per-entry method/flags/crc/size overrides, local vs central name mismatch,
// hidden/empty slide variants, and PPTX package boilerplate.

import zlib from "node:zlib";

const DEFAULT_FLAGS = 0x0800; // UTF-8 names

const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

export function slideMarkup(text, { hidden = false, shapes = true } = {}) {
  const show = hidden ? ' show="0"' : "";
  const sp = shapes && text !== null
    ? `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2800"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS_A} ${NS_R} ${NS_P}${show}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${sp}
</p:spTree></p:cSld></p:sld>`;
}

/**
 * Build the parts of a minimal valid PPTX.
 * slideSpecs: [{ text?, hidden?, shapes? }] — shapes:false creates an empty slide.
 */
export function validPptxParts(slideSpecs) {
  const slides = slideSpecs.map((s) => slideMarkup(s.text ?? null, s));
  const parts = [
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("\n")}
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`) },
    { name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`) },
    { name: "ppt/presentation.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS_A} ${NS_R} ${NS_P}>
<p:sldIdLst>
${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("\n")}
</p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`) },
    { name: "ppt/_rels/presentation.xml.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("\n")}
</Relationships>`) },
    ...slides.map((xml, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: Buffer.from(xml) })),
  ];
  return parts;
}

/**
 * Build a zip from entry specs:
 *   { name, data:Buffer|string, method?: 0|8, flags?: number,
 *     declaredUncomp?: number, declaredComp?: number,   // written to BOTH local+central headers (the "lie")
 *     externalAttrs?: number,
 *     localName?: string, centralName?: string,          // name mismatch (zip quilting)
 *     crcOverride?: number }
 */
export function buildZip(entries, { comment = "" } = {}) {
  const fileParts = [], centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ""), "utf8");
    const method = e.method ?? 8;
    const flags = e.flags ?? DEFAULT_FLAGS;
    const comp = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : Buffer.from(data);
    const crc = e.crcOverride ?? zlib.crc32(data);
    const compSize = e.declaredComp ?? comp.length;
    const uncompSize = e.declaredUncomp ?? data.length;
    const localName = Buffer.from(e.localName ?? e.name, "utf8");
    const centralName = Buffer.from(e.centralName ?? e.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    fileParts.push(local, localName, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(centralName.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(e.externalAttrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, centralName);

    offset += 30 + localName.length + comp.length;
  }
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const commentBuf = Buffer.from(comment, "utf8");
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...fileParts, cd, eocd, commentBuf]);
}

export function validPptxZip(slideSpecs, extra = []) {
  return buildZip([...validPptxParts(slideSpecs), ...extra]);
}

/** PNG with a given IHDR geometry (solid black pixels content — header only matters). */
export function pngWithSize(width, height, { pixels = 8 * 8 } = {}) {
  const crc = zlib.crc32;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc(height * (1 + width * 3)); // filter 0 rows
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
