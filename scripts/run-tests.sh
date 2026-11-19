#!/bin/sh
# Runs the test suite with its output in a throwaway OUTPUT_DIR (out/ stays clean).
set -u
OUT_DIR="$(mktemp -d /tmp/pptx-parser-tests-out.XXXXXX)"
OUTPUT_DIR="$OUT_DIR" PPTX_CONVERT_TIMEOUT_MS=10000 node --test tests/
RC=$?
rm -rf "$OUT_DIR"
echo "out dir $OUT_DIR removed (exit $RC)"
exit $RC
