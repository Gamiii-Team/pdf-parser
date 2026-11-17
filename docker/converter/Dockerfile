# docker/converter/Dockerfile — PPTX→PDF converter for the pdf-parser pipeline.
#
# Isolated by design: no network at runtime, non-root user, no capabilities,
# read-only root filesystem. Node invokes this per conversion job via
# `docker run --rm --network none ...` (see src/input/pptxToPdf.js).
#
# LibreOffice version is pinned via the distro release:
#   debian bookworm => LibreOffice 7.4. Bump the base image to upgrade LO deliberately.
#
# Build:  docker build -t pdf-parser-converter:latest docker/converter
# Cost:   ~+450-600 MB on top of debian:bookworm-slim.

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      fonts-liberation \
      fonts-dejavu \
      fonts-noto-core \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin converter

USER converter
WORKDIR /job

# The invocation args are supplied by src/input/pptxToPdf.js, e.g.:
#   soffice --headless --norestore --convert-to pdf --outdir /job /job/input.pptx \
#     -env:UserInstallation=file:///job/profile
ENTRYPOINT ["soffice"]
