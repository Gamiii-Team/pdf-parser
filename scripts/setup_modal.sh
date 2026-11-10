#!/usr/bin/env bash
# setup_modal.sh — one-shot setup for the Florence-2 figure-extraction endpoint.
#
# Idempotent: safe to re-run. Never prints secret values. Steps:
#   1. sanity-check we are in the repo root and the venv exists (creates it if not)
#   2. check the Modal CLI is authenticated
#   3. seed .env from .env.example (if missing) and generate MODAL_API_SECRET (if empty)
#   4. create the Modal secret `florence-api` from .env (skips with guidance if it exists)
#   5. deploy figure_extraction/florence.py and write MODAL_FLORENCE_URL back into .env
#   6. deploy figure_extraction/florence_pdf.py (the PDF -> JSON app) and write
#      MODAL_PDF_EXTRACT_URL back into .env (same florence-api secret, second app)
#
# The single source of truth for secrets is .env (gitignored). Nothing is echoed
# to the screen; only variable names, not values, ever appear in command lines.
set -euo pipefail

ENV_FILE=".env"
EXAMPLE_FILE=".env.example"
SECRET_NAME="florence-api"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m error:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Repo root + venv -----------------------------------------------------
[ -f figure_extraction/florence.py ] || die "run this from the repository root (figure_extraction/florence.py not found)"

if [ ! -x .venv/bin/python ]; then
    say "no .venv found — creating it and installing figure_extraction/requirements.txt"
    python3 -m venv .venv
    ./.venv/bin/python -m pip install --quiet --upgrade pip
    ./.venv/bin/python -m pip install --quiet -r figure_extraction/requirements.txt
fi
PY=./.venv/bin/python

# --- 2. Modal CLI authentication ----------------------------------------------
if ! "$PY" -m modal profile list >/dev/null 2>&1; then
    die "Modal CLI is not authenticated. Run: $PY -m modal token new   (then re-run this script)"
fi

# --- 3. .env seeded from example; secret generated if empty -------------------
if [ ! -f "$ENV_FILE" ]; then
    say "creating $ENV_FILE from $EXAMPLE_FILE"
    cp "$EXAMPLE_FILE" "$ENV_FILE"
fi

_current_secret() { grep -E "^MODAL_API_SECRET=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '[:space:]'; }

if [ -z "$(_current_secret)" ]; then
    NEW_SECRET="$(openssl rand -hex 32)"
    # GNU sed -i; writes the secret straight into .env without displaying it
    sed -i "s|^MODAL_API_SECRET=.*|MODAL_API_SECRET=${NEW_SECRET}|" "$ENV_FILE"
    say "generated a new MODAL_API_SECRET and wrote it into $ENV_FILE"
else
    say "MODAL_API_SECRET already set in $ENV_FILE — keeping it"
fi

# Load .env without echoing values (no `set -x` in this script)
set -a
# shellcheck disable=SC1091
. "./$ENV_FILE"
set +a

VISION_MODEL="${VISION_MODEL:-florence-2-large}"

# --- 4. Create the Modal secret ------------------------------------------------
if "$PY" -m modal secret list 2>/dev/null | grep -q "$SECRET_NAME"; then
    say "Modal secret '$SECRET_NAME' already exists — keeping it"
    say "note: it must hold the SAME MODAL_API_SECRET as .env; if in doubt, reset with:"
    say "      $PY -m modal secret delete $SECRET_NAME   # then re-run this script"
else
    say "creating Modal secret '$SECRET_NAME' from .env"
    "$PY" -m modal secret create "$SECRET_NAME" \
        MODAL_API_SECRET="$MODAL_API_SECRET" \
        VISION_MODEL="$VISION_MODEL"
fi

# --- 5. Deploy and write the endpoint URL back into .env -----------------------
DEPLOY_LOG="$(mktemp /tmp/modal_deploy_XXXXXX.log)"
say "deploying figure_extraction/florence.py (first run builds the image + downloads the model)"
"$PY" -m modal deploy figure_extraction/florence.py 2>&1 | tee "$DEPLOY_LOG"

DEPLOY_URL="$(grep -oE 'https://[^[:space:]"]+\.modal\.run' "$DEPLOY_LOG" | head -1 || true)"
if [ -n "$DEPLOY_URL" ]; then
    if grep -qE '^MODAL_FLORENCE_URL=.+' "$ENV_FILE"; then
        say "MODAL_FLORENCE_URL already set in $ENV_FILE — leaving it as-is"
        say "(new deployment URL, if different: $DEPLOY_URL)"
    else
        sed -i "s|^MODAL_FLORENCE_URL=.*|MODAL_FLORENCE_URL=${DEPLOY_URL}|" "$ENV_FILE"
        say "wrote MODAL_FLORENCE_URL into $ENV_FILE"
    fi
else
    warn "could not parse the endpoint URL from the deploy output (see log above)."
    warn "copy the deployed URL manually into $ENV_FILE as MODAL_FLORENCE_URL=..."
fi

# --- 6. Deploy the PDF -> JSON app (figure_extraction/florence_pdf.py) ---------
# Separate Modal app, same florence-api secret — no new secret needed.
DEPLOY_LOG2="$(mktemp /tmp/modal_deploy_pdf_XXXXXX.log)"
say "deploying figure_extraction/florence_pdf.py (PDF -> JSON scenario)"
"$PY" -m modal deploy figure_extraction/florence_pdf.py 2>&1 | tee "$DEPLOY_LOG2"

PDF_DEPLOY_URL="$(grep -oE 'https://[^[:space:]"]+\.modal\.run' "$DEPLOY_LOG2" | grep -- 'extract-pdf' | head -1 || true)"
if [ -n "$PDF_DEPLOY_URL" ]; then
    if grep -qE '^MODAL_PDF_EXTRACT_URL=.+' "$ENV_FILE"; then
        say "MODAL_PDF_EXTRACT_URL already set in $ENV_FILE — leaving it as-is"
        say "(new deployment URL, if different: $PDF_DEPLOY_URL)"
    else
        sed -i "s|^MODAL_PDF_EXTRACT_URL=.*|MODAL_PDF_EXTRACT_URL=${PDF_DEPLOY_URL}|" "$ENV_FILE"
        say "wrote MODAL_PDF_EXTRACT_URL into $ENV_FILE"
    fi
else
    warn "could not parse the extract-pdf endpoint URL from the deploy output (see log above)."
    warn "copy the deployed URL manually into $ENV_FILE as MODAL_PDF_EXTRACT_URL=..."
fi

say "done. Verify with:"
say "  curl -s ${DEPLOY_URL:-\$MODAL_FLORENCE_URL}/healthz"
say "  python -m figure_extraction.pipeline ./test.pdf"
say "  python -m figure_extraction.pdf_to_json ./test.pdf --out ./test.pdf.json --debug"
rm -f "$DEPLOY_LOG"
rm -f "$DEPLOY_LOG2"
