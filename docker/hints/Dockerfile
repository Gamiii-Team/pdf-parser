# docker/hints/Dockerfile — native PPTX hints extractor for the pdf-parser pipeline.
# Runs INSIDE an isolated, networkless, non-root container. The deck is uploaded
# read-only; stdout carries the JSON (parsed by src/input/pptxHints.js).
#
# Build:  docker build -t pdf-parser-hints:latest docker/hints
# Cost:   ~50 MB on top of python:3.12-alpine.

FROM python:3.12-alpine

RUN pip install --no-cache-dir python-pptx==1.0.2 \
 && adduser -D -u 10002 -s /sbin/nologin hints

COPY src/input/pptx_hints.py /opt/pptx_hints.py

USER hints
WORKDIR /job

ENTRYPOINT ["python", "/opt/pptx_hints.py"]
