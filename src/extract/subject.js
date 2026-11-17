// src/extract/subject.js
// Subject detection: one cheap call on the extracted outline/text sample.
// Auto-subject is only attempted when a provider is configured and the caller doesn't pass --subject.

function summarizeForPrompt(blocks, maxChars = 1800) {
  const bits = [];
  for (const b of blocks) {
    if (bits.join(" ").length > maxChars) break;
    if (b.type === "heading") bits.push(`# ${b.content}`);
    else if (b.type === "text" && typeof b.content === "string") bits.push(b.content.slice(0, 240));
    else if (b.type === "table" && b.caption) bits.push(`[table: ${b.caption}]`);
    else if (b.type === "chart" && b.caption) bits.push(`[chart: ${b.caption}]`);
    else if (b.type === "list" && b.items?.length) bits.push(`[list: ${b.items.slice(0, 3).join("; ")}]`);
  }
  return bits.join("\n").slice(0, maxChars + 400);
}

/**
 * @param {string | undefined} subject
 * @param {{ blocks: object[], provider: object | null, logger: any }} opts
 * @returns {Promise<{ subject: string, subject_source: "user" | "auto" | "unavailable" }>}
 */
export async function resolveSubject(subject, { blocks, provider, logger } = {}) {
  if (subject && subject.trim()) return { subject: subject.trim(), subject_source: "user" };
  if (!provider) return { subject: "unknown", subject_source: "unavailable" };

  const sample = summarizeForPrompt(blocks ?? []);
  if (!sample.trim()) return { subject: "unknown", subject_source: "unavailable" };

  const messages = [{
    role: "user",
    content: [{
      type: "text",
      text:
        "You are a document subject classifier. You will see a sample of text/structure from ONE document.\n" +
        "Return ONLY a JSON object: {\"subject\": \"<3-6 word description>\"}.\n" +
        "Report the document's main subject, not its format or venue. No commentary.\n\n" +
        sample,
    }],
  }];

  try {
    const { text, usage } = await provider.complete(messages, { maxTokens: 80, temperature: 0.1 });
    const m = String(text).match(/\{[^{}]*"subject"\s*:\s*"([^"]+)"[^{}]*\}/s);
    const s = m ? m[1].trim() : "";
    if (s) return { subject: s, subject_source: "auto", usage };
    // Fallback: plain text response with no JSON
    const plain = String(text).trim().slice(0, 120);
    if (plain) return { subject: plain, subject_source: "auto", usage };
    return { subject: "unknown", subject_source: "unavailable", usage };
  } catch (err) {
    logger?.warn?.(`subject detection failed: ${err.message}`);
    return { subject: "unknown", subject_source: "unavailable", error: err.message };
  }
}
