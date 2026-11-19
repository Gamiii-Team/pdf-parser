#!/usr/bin/env node
// scripts/create-pptx-fixture.mjs
// Generates fixtures/sample.pptx — a minimal but real PowerPoint deck.
// Used to verify: pptx validation, LibreOffice conversion, hidden/empty slide
// exclusion (effective slide count = 3), and table/image handling downstream.
//
// Deck layout
//   slide1  Title + bullet list ("Quarterly sample")
//   slide2  "Monthly figures" + a real a:tbl table
//   slide3  Picture slide — embedded PNG chart + caption
//   slide4  HIDDEN  (<p:sld show="0">)  → must not count toward the cap
//   slide5  EMPTY   (no shapes)         → must not count toward the cap
//
// Run: node scripts/create-pptx-fixture.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "fixtures", "sample.pptx");

const NS_A = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"";
const NS_R = "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";
const NS_P = "xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";

// ---------- chart image ----------
// scripts/make-chart-png.py draws a readable chart (title + axis numbers + gridlines + months)
// with PyMuPDF so a VLM can transcribe it with estimates:true.
import { execFileSync } from "node:child_process";

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChartPng() {
  const out = path.join(os.tmpdir(), `sample-chart-${process.pid}-${Date.now()}.png`);
  const python = fs.existsSync(path.join(__dirname, "..", ".venv", "bin", "python"))
    ? path.join(__dirname, "..", ".venv", "bin", "python")
    : (process.env.PYTHON ?? "python3");
  try {
    execFileSync(python, [path.join(__dirname, "make-chart-png.py"), out], { stdio: "inherit" });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

// ---------- slide builders ----------
function sp(text, { x = 685800, y = 457200, cx = 8229600, cy = 1143000, size = 3200, bold = true, name = "Text" } = {}) {
  return `
  <p:sp><p:nvSpPr><p:cNvPr id="${sp._id = (sp._id ?? 10) + 1}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
  <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}
function bullets(items, { x = 685800, y = 2100000, cx = 8229600, cy = 3000000 } = {}) {
  const ps = items.map((t) => `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${t}</a:t></a:r></a:p>`).join("");
  return `
  <p:sp><p:nvSpPr><p:cNvPr id="${sp._id = (sp._id ?? 10) + 1}" name="Bullets"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
  <p:txBody><a:bodyPr/><a:lstStyle/>${ps}</p:txBody></p:sp>`;
}
function table(rows, { x = 685800, y = 2100000, cx = 7772400 } = {}) {
  const cols = rows[0].length;
  const gw = Math.floor(cx / cols);
  const grid = `<a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${gw}"/>`).join("")}</a:tblGrid>`;
  const tcPr = `<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr"><a:lnL w="12700"><a:solidFill><a:srgbClr val="B0B0B0"/></a:solidFill></a:lnL><a:lnR w="12700"><a:solidFill><a:srgbClr val="B0B0B0"/></a:solidFill></a:lnR><a:lnT w="12700"><a:solidFill><a:srgbClr val="B0B0B0"/></a:solidFill></a:lnT><a:lnB w="12700"><a:solidFill><a:srgbClr val="B0B0B0"/></a:solidFill></a:lnB></a:tcPr>`;
  const trs = rows.map((r, i) => `<a:tr h="400000">${r.map((cell) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1600" b="${i === 0 ? 1 : 0}"/><a:t>${cell}</a:t></a:r></a:p></a:txBody>${tcPr}</a:tc>`).join("")}</a:tr>`).join("");
  return `
  <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${sp._id = (sp._id ?? 10) + 1}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
  <p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="2400000"/></p:xfrm>
  <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/>${grid}${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function pic({ x = 685800, y = 2100000, cx = 4800000, cy = 3000000, relId = "rEmbed1", name = "ChartImage" } = {}) {
  return `
  <p:pic><p:nvPicPr><p:cNvPr id="${sp._id = (sp._id ?? 10) + 1}" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
  <p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}
const SP_TREE_OPEN = `<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
const SP_TREE_CLOSE = `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>`;

function slideXml(body, { hidden = false } = {}) {
  const show = hidden ? ' show="0"' : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS_A} ${NS_R} ${NS_P}${show}>${SP_TREE_OPEN}${body}${SP_TREE_CLOSE}</p:sld>`;
}

const slides = [
  slideXml(
    sp("PPTX Fixture: Quarterly Sample", { y: 500000, size: 3600, name: "Title" }) +
    bullets(["Revenue grew steadily across the half-year.", "Product A remains the largest contributor.", "Costs stayed within budget in every month."]),
  ),
  slideXml(
    sp("Monthly Figures", { y: 500000, size: 3000, name: "Title" }) +
    table([["Month", "Revenue", "Costs", "Profit"], ["January", "10", "6", "4"], ["February", "12", "7", "5"], ["March", "15", "8", "7"], ["April", "14", "8", "6"]]),
  ),
  slideXml(
    sp("Figure: Revenue by Month", { y: 500000, size: 3000, name: "Title" }) +
    pic({ y: 1700000, cx: 4800000, cy: 3000000 }) +
    sp("Bar chart comparing January to April revenue.", { y: 4900000, cx: 8229600, cy: 600000, size: 1600, bold: false, name: "Caption" }),
  ),
  slideXml(sp("Hidden Appendix — should not appear in output", { size: 2800 }), { hidden: true }),
  slideXml(""), // empty slide
];

const png = makeChartPng();
const entries = [];
function add(name, content) { entries.push({ name, data: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8") }); }

add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("\n")}
<Override PartName="/ppt/notesSlides/notesSlide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`);
add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
add("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS_A} ${NS_R} ${NS_P}>
<p:sldIdLst>
${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("\n")}
</p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`);
add("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("\n")}
</Relationships>`);
slides.forEach((xml, i) => add(`ppt/slides/slide${i + 1}.xml`, xml));
add("ppt/slides/_rels/slide3.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rEmbed1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/chart.png"/>
</Relationships>`);
add("ppt/media/chart.png", png);

// Speaker notes for slide 2 (Monthly Figures) — not present in the rendered PDF,
// so they exercise the native-hints path end to end.
add("ppt/slides/_rels/slide2.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/>
</Relationships>`);
add("ppt/notesSlides/_rels/notesSlide2.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide2.xml"/>
</Relationships>`);
add("ppt/notesSlides/notesSlide2.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes ${NS_A} ${NS_R} ${NS_P}>
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1600"/><a:t>Speaker notes: margins review quarterly; the table holds the estimated figures.</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld>
</p:notes>`);

// ---------- minimal ZIP writer (deflate) ----------
function buildZip(entries) {
  const fileParts = [], centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 flag
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    fileParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);    // UTF-8 flag
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); // extra, comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);   // local header offset
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }
  const cdOffset = offset;
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...fileParts, cd, eocd]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const zip = buildZip(entries);
fs.writeFileSync(OUT, zip);
console.log(`wrote ${OUT} (${(zip.length / 1024).toFixed(1)} KB, ${entries.length} parts)`);
