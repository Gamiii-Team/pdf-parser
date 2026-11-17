// src/input/pptxToPdf.js — .pptx → PDF via LibreOffice, isolated in a container.
//
// Backends (PPTX_CONVERTER):
//   docker (default) — `docker run --rm --network none ...` with the
//                      pdf-parser-converter image (see docker/converter/Dockerfile).
//                      Non-root, no network, read-only rootfs, 1 GB memory cap,
//                      100-PID cap, 1.5 CPU cap, no-new-privileges, all caps dropped.
//   host             — spawn a locally installed `soffice` (PPTX_SOFFICE_PATH or
//                      $PATH). For environments where Docker can't run. Same
//                      flags, timeout and cleanup, just no container isolation.
//
// Conversion work happens inside a per-job dir under <repo>/data/convert/<jobId>/
// (input copy + isolated soffice profile). The produced PDF is moved out to
// os.tmpdir() for the pipeline; the job dir is removed immediately after
// conversion (success or failure). 25 MB uploads in, ~MBs of scratch out.
//
// Env knobs (see .env.example):
//   PPTX_CONVERTER            docker | host                 (default: docker)
//   PPTX_CONVERTER_IMAGE      image tag                     (default: pdf-parser-converter:latest)
//   PPTX_SOFFICE_PATH         host mode: path to soffice    (default: "soffice")
//   PPTX_CONVERT_TIMEOUT_MS   kill conversion after N ms    (default: 5000 — see README; raise if LEGIT decks time out)
//   PPTX_CONVERT_CONCURRENCY  max simultaneous conversions  (default: 2; excess waits in queue)
//   PPTX_JOB_ROOT             scratch root                  (default: <repo>/data/convert)

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { spawnWorker } from "../pymupdf/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const int = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const CONVERTER = (process.env.PPTX_CONVERTER ?? "docker").trim() || "docker";
const IMAGE     = (process.env.PPTX_CONVERTER_IMAGE ?? "pdf-parser-converter:latest").trim();
const SOFFICE   = (process.env.PPTX_SOFFICE_PATH ?? "soffice").trim();
const TIMEOUT   = () => int("PPTX_CONVERT_TIMEOUT_MS", 5000);
const CONCURRENCY = () => int("PPTX_CONVERT_CONCURRENCY", 2);
const JOB_ROOT  = () => path.resolve(process.env.PPTX_JOB_ROOT ?? path.join(REPO_ROOT, "data", "convert"));

export class PptxConversionError extends Error {
  constructor(message, { cause, stderr } = {}) {
    super(message);
    this.name = "PptxConversionError";
    this.code = "PPTX_CONVERT_FAILED";
    this.cause = cause;
    this.stderr = stderr;
  }
}

// ── Concurrency semaphore (module-level queue) ────────────────────────────────
let active = 0;
const waiters = [];

function acquire() {
  const limit = CONCURRENCY();
  if (active < limit) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) { active++; next(); }
}

/** How many conversions are running right now (test/observability). */
export function conversionsInFlight() { return active; }

const silent = () => {}; // eslint-disable-line

/** Spawn detached so the whole process group can be SIGKILLed on timeout. */
function runDetached(cmd, args, { timeoutMs, onTimeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const cap = (buf, add) => (buf.length < 64 * 1024 ? buf + add : buf);
    child.stdout.on("data", (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on("data", (d) => { stderr = cap(stderr, d.toString()); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout?.(); // e.g. docker kill <cid> — kills the container, not just the CLI wrapper
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function removeQuiet(target) {
  try { await fs.promises.rm(target, { recursive: true, force: true }); } catch {} // best-effort; logged by callers if critical
}

async function moveToTmp(from) {
  const tmp = path.join(os.tmpdir(), `docv2-pptx-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.pdf`);
  try {
    await fs.promises.rename(from, tmp);
  } catch (err) {
    if (err?.code !== "EXDEV") throw err; // cross-device: job dir on another fs (e.g. external drive vs /tmp)
    await fs.promises.copyFile(from, tmp);
    await fs.promises.unlink(from);
  }
  return tmp;
}

function jobPaths(jobId) {
  const jobDir = path.join(JOB_ROOT(), jobId);
  return {
    jobDir,
    input: path.join(jobDir, "input.pptx"),
    pdf: path.join(jobDir, "input.pdf"),
    profile: path.join(jobDir, "profile"),
    cidfile: path.join(jobDir, "cid"),
  };
}

let dockerImageReady = false;
async function ensureDockerImage() {
  if (dockerImageReady) return;
  const res = await runDetached("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"], { timeoutMs: 10000 });
  if (res.code !== 0) {
    throw new PptxConversionError(`converter image "${IMAGE}" not found — build it once with: docker build -t ${IMAGE} docker/converter`);
  }
  dockerImageReady = true;
}

async function dockerConvert(paths, logger) {
  await ensureDockerImage();
  const args = [
    "run", "--rm",
    "--network", "none",
    "--read-only",
    "--memory", "1g", "--memory-swap", "1g",   // no swap → runaway conversion gets OOM-killed inside the container
    "--pids-limit", "100",
    "--cpus", "1.5",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
    "-e", "HOME=/job",
    "-v", `${paths.jobDir}:/job:rw`,
    "--cidfile", paths.cidfile,   // written by the docker CLI on the host before the container starts
    IMAGE, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", "/job", "/job/input.pptx", `-env:UserInstallation=file:///job/profile`,
  ];

  logger?.info?.(`pptx: converting via docker image ${IMAGE}`);
  const res = await runDetached("docker", args, {
    timeoutMs: TIMEOUT(),
    onTimeout: () => {
      try {
        const cid = fs.readFileSync(paths.cidfile, "utf8").trim();
        if (cid) spawn("docker", ["kill", cid], { stdio: "ignore" });
      } catch { /* cidfile never written or already gone */ }
    },
  });
  if (res.timedOut) {
    throw new PptxConversionError(`conversion timed out after ${TIMEOUT()} ms — the deck is too complex to convert in that time. Simplify it (fewer charts, smaller images) or export to PDF yourself.`, { stderr: res.stderr });
  }
  if (res.code !== 0) {
    const tail = res.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    throw new PptxConversionError(`LibreOffice conversion failed (exit ${res.code})${tail ? `: ${tail}` : ""}`, { stderr: res.stderr });
  }
}

async function hostConvert(paths, logger) {
  logger?.info?.(`pptx: converting via host soffice (${SOFFICE})`);
  const args = [
    "--headless", "--norestore", "--convert-to", "pdf",
    "--outdir", paths.jobDir, paths.input,
    `-env:UserInstallation=file://${paths.profile}`,
  ];
  const res = await runDetached(SOFFICE, args, { timeoutMs: TIMEOUT() });
  if (res.timedOut) {
    throw new PptxConversionError(`conversion timed out after ${TIMEOUT()} ms — the deck is too complex to convert in that time. Simplify it (fewer charts, smaller images) or export to PDF yourself.`, { stderr: res.stderr });
  }
  if (res.code !== 0) {
    const tail = res.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    throw new PptxConversionError(`LibreOffice conversion failed${tail ? `: ${tail}` : ""}. Is LibreOffice installed and on PATH${SOFFICE !== "soffice" ? ` (PPTX_SOFFICE_PATH=${SOFFICE})` : ""}?`, { stderr: res.stderr });
  }
}

/**
 * Convert a validated .pptx to PDF.
 * @param {string} inputPath absolute path to the .pptx (already validated)
 * @param {{ logger?: { info?: Function, warn?: Function }, hideEmptySlides?: boolean }} [options]
 *   hideEmptySlides — mark shape-less slides show="0" in the job copy before conversion
 *   (LibreOffice skips hidden slides), so they are never rendered or cost VLM calls.
 * @returns {Promise<{ pdfPath: string }>} absolute path to a temp PDF the caller owns
 *   (delete with fs.unlink / normalize.js cleanupPath).
 */
export async function convertPptxToPdf(inputPath, options = {}) {
  const logger = options.logger ?? { info: silent, warn: silent };
  await acquire();
  const jobId = crypto.randomBytes(8).toString("hex");
  const paths = jobPaths(jobId);
  try {
    await fs.promises.mkdir(paths.jobDir, { recursive: true });
    await fs.promises.mkdir(paths.profile, { recursive: true });
    await fs.promises.copyFile(inputPath, paths.input);

    // Hide empty slides in the job copy — LibreOffice skips hidden slides, so
    // they never reach the PDF. The user's original file is never modified.
    if (options.hideEmptySlides) {
      const rewritten = `${paths.input}.rewritten.pptx`;
      try {
        await spawnWorker(["hide-empty-slides", paths.input, rewritten]);
        await fs.promises.rename(rewritten, paths.input);
        logger?.info?.("pptx: hidden empty slides in job copy");
      } catch (err) {
        await fs.promises.rm(rewritten, { force: true }).catch(() => {});
        throw new PptxConversionError(`could not hide empty slides in job copy: ${err?.message ?? err}`);
      }
    }

    if (CONVERTER === "host") await hostConvert(paths, logger);
    else if (CONVERTER === "docker") await dockerConvert(paths, logger);
    else throw new PptxConversionError(`unknown PPTX_CONVERTER=${CONVERTER} (expected "docker" or "host")`);

    const stat = await fs.promises.stat(paths.pdf).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new PptxConversionError("LibreOffice produced no PDF output (it may have refused to open the file)", {});
    }
    // Move the PDF out of the job dir to a standalone temp file; job dir goes away now.
    const pdfPath = await moveToTmp(paths.pdf);
    return { pdfPath };
  } catch (err) {
    if (err instanceof PptxConversionError) throw err;
    if (err?.code === "ENOENT") {
      // docker(1) or soffice missing entirely
      const what = CONVERTER === "host" ? `host soffice not found at "${SOFFICE}"` : "docker not found or the converter image is missing";
      const fix = CONVERTER === "host"
        ? "install LibreOffice (e.g. apt install libreoffice-impress) or set PPTX_CONVERTER=docker and build the image"
        : "build it once with: docker build -t pdf-parser-converter:latest docker/converter";
      throw new PptxConversionError(`${what} — ${fix}`, { cause: err });
    }
    throw new PptxConversionError(`conversion failed: ${err?.message ?? err}`, { cause: err });
  } finally {
    await removeQuiet(paths.jobDir);
    release();
  }
}
