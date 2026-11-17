// src/extract/treeBuilder.js
// §3/§6.3 — Flat typed blocks → recursive sections tree.
// Reads in visual order; headings define section boundaries.

/**
 * @param {Array<{type: string, page: number, bbox?: number[], content?: any, items?: string[], level?: number, caption?: string|null, needs_review?: boolean}>} flatBlocks
 * @param {{ fallbackHeading?: string }} opts
 * @returns {Array<object>} sections
 */
export function buildTree(flatBlocks, opts = {}) {
  let _sid = 0, _bid = 0;
  const sectionId = () => `s${String(++_sid).padStart(3, "0")}`;
  const blockId = () => `b${String(++_bid).padStart(3, "0")}`;

  // Sort by page only (stable): intra-page order = input order, which puts the
  // span-derived blocks first and lets VLM-appended blocks trail them.
  // (Previously y-coordinate sorted null-bbox VLM blocks as y=0, ahead of all
  // span content — chart blocks jumped their own heading.)
  const sorted = [...flatBlocks].map((block, index) => ({ block, index }))
    .sort((a, b) => (a.block.page - b.block.page) || (a.index - b.index))
    .map(({ block }) => block);

  const sections = [];
  const stack = [];

  const pushSection = (heading, level, page) => {
    const sec = {
      id: sectionId(),
      heading,
      level,
      pages: [page],
      content: [],
      subsections: [],
    };
    if (stack.length) stack[stack.length - 1].section.subsections.push(sec);
    else sections.push(sec);
    stack.push({ section: sec, level });
    return sec;
  };

  const topSection = () => (stack.length ? stack[stack.length - 1].section : null);

  for (const block of sorted) {
    if (block.type === "heading") {
      const level = Math.max(1, Math.min(6, Number(block.level) || 1));
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      pushSection(block.content, level, block.page);
      continue;
    }
    if (!stack.length) {
      const synth = {
        id: sectionId(),
        heading: opts.fallbackHeading ?? "Document",
        level: 1,
        pages: [block.page ?? 1],
        content: [],
        subsections: [],
      };
      sections.push(synth);
      stack.push({ section: synth, level: 1 });
    }
    const target = topSection();
    const assigned = { ...block, id: blockId() };
    if (!target.pages.includes(block.page)) target.pages.push(block.page);
    target.content.push(assigned);
  }

  const walk = (s) => {
    s.pages = [...new Set(s.pages)].sort((a, b) => a - b);
    for (const sub of s.subsections) walk(sub);
  };
  for (const s of sections) walk(s);
  return sections;
}

export function countSections(sections) {
  // Counts sections (including subsections), not blocks.
  let n = 0;
  for (const s of sections ?? []) {
    n += 1 + countSections(s.subsections ?? []);
  }
  return n;
}
