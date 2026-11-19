// src/input/pptxHints.js — native hints from a .pptx (chart values, notes, hidden slides).
// Runs src/input/pptx_hints.py INSIDE the converter container (python-pptx) to
// keep parsing of the untrusted file inside the isolation boundary and away
// from the host's Python. Never throws: any failure returns [].
//
// Hints are an enhancement — the VLM path works fine from image + text layer alone.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = (process.env.PPTX_HINTS_IMAGE ?? "pdf-parser-hints:latest").trim();
const TIMEOUT_MS = 15000;

export async function extractHints(deckPath, options = {}) {
  const logger = options.logger ?? { info() {}, warn() {} };
  const file = path.resolve(deckPath);
  if (!fs.existsSync(file)) return { hints: [], ok: false, reason: "input missing" };
  const cidfile = path.join(os.tmpdir(), `pptx-hints-${crypto.randomBytes(6).toString("hex")}.cid`);
  try {
    const hintsRaw = await run([
      "run", "--rm",
      "--network", "none",
      "--read-only",
      "--memory", "512m", "--memory-swap", "512m",
      "--pids-limit", "100",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "-e", "HOME=/tmp",
      "-v", `${file}:/deck.pptx:ro`,
      "--cidfile", cidfile,
      IMAGE,
      "/deck.pptx",
    ], TIMEOUT_MS, cidfile);
    const parsed = parseHints(hintsRaw.stdout);
    logger?.info?.("pptx hints: " + (parsed.ok ? `${parsed.hints.length} slide entries` : "unavailable"));
    return parsed;
  } catch (err) {
    logger?.warn?.(`pptx hints unavailable (${err?.message ?? err}) — continuing without native hints`);
    return { hints: [], ok: false, reason: String(err?.message ?? err) };
  } finally {
    fs.rmSync(cidfile, { force: true });
  }
}

function parseHints(stdout) {
  try {
    const arr = JSON.parse(String(stdout).trim() || "[]");
    if (!Array.isArray(arr)) return { hints: [], ok: false, reason: "hints output not a list" };
    return { hints: arr, ok: true };
  } catch {
    return { hints: [], ok: false, reason: "hints output not valid JSON" };
  }
}

function run(args, timeoutMs, cidfile) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const cap = (buf, add) => (buf.length < 4 * 1024 * 1024 ? buf + add : buf);
    child.stdout.on("data", (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d.toString()); });
    const timer = setTimeout(() => {
      // Kill the container itself, then the docker CLI wrapper.
      try {
        const cid = fs.readFileSync(cidfile, "utf8").trim();
        if (cid) spawn("docker", ["kill", cid], { stdio: "ignore" });
      } catch { /* never started or already gone */ }
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (stdout.trim()) return resolve({ code, signal, stdout, stderr });
      if (code !== 0) return reject(new Error(`exit ${code}: ${stderr.trim().slice(0, 300)}`));
      resolve({ code, signal, stdout, stderr });
    });
  });
}
