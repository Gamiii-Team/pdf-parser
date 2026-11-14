"""
Modal app: OpenAI-compatible vLLM server for a Qwen VL model.

Sibling of the existing `florence2-figure-extractor` / `florence2-pdf-extractor`
apps (which use the same @app.function + @modal.fastapi_endpoint pattern).
Serves Qwen/Qwen3-VL-4B-Instruct by default (override with VLLM_MODEL).
The JS `full-modal` pipeline posts to it with `Authorization: Bearer $MODAL_API_SECRET`.

Secrets: reads MODAL_API_SECRET from the existing `florence-api` Modal secret
(the same secret used by the Florence apps) and exposes it to vLLM as
`--api-key`, mirroring the Florence endpoint auth pattern.

Deploy:
    python -m modal deploy modal/vllm_app.py

The deploy prints the endpoint URL — copy it into the repo-root .env as
MODAL_ENDPOINT_URL.
"""

import asyncio
import json
import os
import subprocess
import time
import urllib.request

import fastapi
import modal

DEFAULT_MODEL = "Qwen/Qwen3-VL-4B-Instruct"
VLLM_PORT = 8000
# vLLM must support the Qwen3-VL architecture; keep this reasonably current.
VLLM_IMAGE_TAG = "vllm/vllm-openai:v0.11.1"

app = modal.App("florence2-vllm")

# Bake the model into the image so cold starts don't re-download ~8 GB every
# time. The HF download happens at image BUILD time (cached by Modal).
vllm_image = (
    modal.Image.from_registry(VLLM_IMAGE_TAG, add_python="3.12")
    .pip_install("aiohttp", "fastapi[standard]")
    .run_commands(
        f"huggingface-cli download {DEFAULT_MODEL}",
    )
)

_STATE = {"proc": None}


def _wait_for_vllm(timeout_s: int = 600) -> bool:
    """Block until vLLM accepts connections on VLLM_PORT (or give up)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        proc = _STATE["proc"]
        if proc is not None and proc.poll() is not None:
            print(f"vllm exited early: code={proc.returncode}", flush=True)
            return False
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{VLLM_PORT}/v1/models")
            urllib.request.urlopen(req, timeout=3)
            return True
        except Exception:
            time.sleep(2)
    return False


@app.function(
    image=vllm_image,
    gpu=os.environ.get("VLLM_GPU", "T4"),   # 4B bf16 (~8 GB) fits a T4 16 GB
    scaledown_window=int(os.environ.get("VLLM_SCALEDOWN_WINDOW", "300")),
    timeout=900,
    secrets=[modal.Secret.from_name("florence-api")],
)
@modal.fastapi_endpoint(method="POST")
async def proxy(request: fastapi.Request):
    api_key = os.environ["MODAL_API_SECRET"]
    if request.headers.get("authorization") != f"Bearer {api_key}":
        return fastapi.responses.JSONResponse({"error": "unauthorized"}, status_code=401)

    global _STATE
    if _STATE["proc"] is None or _STATE["proc"].poll() is not None:
        model = os.environ.get("VLLM_MODEL", DEFAULT_MODEL)
        max_len = os.environ.get("VLLM_MAX_MODEL_LEN", "16384")
        cmd = [
            "vllm", "serve", model,
            "--host", "127.0.0.1",
            "--port", str(VLLM_PORT),
            "--api-key", api_key,
            "--max-model-len", str(max_len),
            "--served-model-name", model,
            "--uvicorn-log-level=warning",
            "--enforce-eager",
        ]
        print("launching:", " ".join(cmd[:6] + ["..."]), flush=True)
        _STATE["proc"] = subprocess.Popen(cmd)

    if not _wait_for_vllm(timeout_s=600):
        return fastapi.responses.JSONResponse(
            {"error": "vllm engine did not come up in time"}, status_code=503)

    body = await request.body()
    path = request.url.path
    if not path.startswith("/v1/"):
        path = f"/v1{path}"
    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.request(
                request.method,
                f"http://127.0.0.1:{VLLM_PORT}{path}",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
            ) as resp:
                data = await resp.read()
                return fastapi.Response(content=data, status_code=resp.status,
                                        media_type=resp.content_type)
    except Exception as exc:
        return fastapi.responses.JSONResponse(
            {"error": f"upstream vllm request failed: {exc}"}, status_code=502)


@app.function(image=modal.Image.debian_slim().pip_install("fastapi[standard]"), timeout=30)
@modal.fastapi_endpoint(method="GET")
def healthz():
    return {"status": "ok"}
