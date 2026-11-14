#!/usr/bin/env node
// scripts/setup-venv.mjs
// Bootstrap the Python .venv this repo needs (src/pymupdf/worker.py).
// Creates .venv if missing, installs requirements.txt, verifies the worker import.
// Never deletes anything. Idempotent — safe to re-run.
//
// Usage: npm run setup
//        PYTHON=/path/to/python3 npm run setup   # override interpreter

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const VENV = path.join(REPO, ".venv");
const REQUIREMENTS = path.join(REPO, "requirements.txt");
const isWindows = process.platform === "win32";

const venvPython = path.join(
  VENV,
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python",
);
const venvPip = path.join(
  VENV,
  isWindows ? "Scripts" : "bin",
  isWindows ? "pip.exe" : "pip",
);

function tryRun(cmd, args, opts = {}) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", ...opts });
    return true;
  } catch {
    return false;
  }
}

function findSystemPython() {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
  for (const cmd of candidates) {
    if (tryRun(cmd, ["-c", "import sys"])) return cmd;
  }
  return null;
}

function alreadyReady() {
  if (!fs.existsSync(venvPython)) return false;
  return tryRun(venvPython, ["-c", "import pymupdf"]);
}

function main() {
  console.log(`repo:  ${REPO}`);

  if (alreadyReady()) {
    console.log("✔ .venv already ready — pymupdf imports fine");
    return;
  }

  const systemPython = findSystemPython();
  if (!systemPython) {
    console.error("✖ no working python3/python interpreter found on PATH.");
    console.error("  Install Python 3 (≥3.10) and retry: `sudo apt install python3` (Debian/Ubuntu) or similar.");
    process.exit(1);
  }
  console.log(`python: ${systemPython}`);

  // 1) Create .venv if it doesn't exist
  if (!fs.existsSync(VENV)) {
    console.log("creating .venv …");
    try {
      execFileSync(systemPython, ["-m", "venv", VENV], { stdio: "inherit" });
    } catch (err) {
      console.error("✖ could not create .venv. Common causes:");
      console.error("  - missing `python3-venv` package (Debian/Ubuntu: sudo apt install python3-venv)");
      console.error(`  - or broken pip: try '${systemPython} -m pip --version' and install pip first`);
      process.exit(1);
    }
  } else {
    console.log(".venv exists — installing missing dependencies");
  }

  // 2) pip install -r requirements.txt
  if (!fs.existsSync(venvPip)) {
    console.error("✖ .venv/bin/pip not found — the venv looks incomplete.");
    console.error("  Delete it and re-run: rm -rf .venv && npm run setup");
    process.exit(1);
  }
  console.log("installing dependencies from requirements.txt …");
  execFileSync(venvPip, ["install", "-r", REQUIREMENTS], { stdio: "inherit" });

  // 3) verify the worker can import its dependency
  if (!tryRun(venvPython, ["-c", "import pymupdf"])) {
    console.error("✖ pymupdf failed to import after install — try again or report it.");
    process.exit(1);
  }
  console.log("✔ .venv ready — Python side is good. Try `npm test`.");
}

main();
