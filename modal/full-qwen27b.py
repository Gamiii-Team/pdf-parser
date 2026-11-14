"""
Modal app: OpenAI-compatible vLLM server for Qwen3.8-27B-Instruct-FP8.

Sibling of florence2-figure-extractor / florence2-pdf-extractor / florence2-vllm.
Serves Qwen/Qwen3.8-27B-Instruct-FP8 (~30 GB) — requires an A100-40GB or larger.
Used by the JS `full-qwen-27b` extraction mode.

Secrets: reads MODAL_API_SECRET from the existing `florence-api` Modal secret
(the same secret used by the other apps) and exposes it to vLLM as `--api-key`.

Deploy:
    set -a; source .env; set +a
    python -m modal deploy modal/full-qwen27b.py

The deploy prints a URL like https://<you>--florence2-qwenvl-27b-server.us-east.modal.direct
— copy it into the repo-root .env as MODAL_FULL_QWEN_27B_URL.
"""

import os
import subprocess
import sys

import modal

DEFAULT_MODEL = "Qwen/Qwen3.8-27B-Instruct-FP8"
# vLLM must support the qwen3_vl architecture; keep this reasonably current.
VLLM_IMAGE_TAG = "vllm/vllm-openai:v0.11.1"

app = modal.App("florence2-qwenvl-27b")

# Bake the model into the image so cold starts don't re-download ~30 GB every
# time. The HF download happens at image BUILD time (cached by Modal).
vllm_image = (
    modal.Image.from_registry(VLLM_IMAGE_TAG, add_python="3.12")
    .run_commands(
        f"huggingface-cli download {DEFAULT_MODEL}",
    )
)


@app.server(
    image=vllm_image,
    gpu=os.environ.get("VLLM_GPU_27B", "A100-40GB"),  # 27B FP8 (~30 GB) fits an A100-40GB
    scaledown_window=int(os.environ.get("VLLM_SCALEDOWN_WINDOW", "300")),
    startup_timeout=int(os.environ.get("VLLM_STARTUP_TIMEOUT", "1800")),  # big model
    port=8000,
    routing_region="us-east",
    target_concurrency=100,
    unauthenticated=True,  # auth happens inside vLLM via --api-key
    secrets=[modal.Secret.from_name("florence-api")],
)
class Server:
    @modal.enter()
    def start(self):
        model = os.environ.get("VLLM_MODEL_27B", DEFAULT_MODEL)
        api_key = os.environ["MODAL_API_SECRET"]
        max_len = os.environ.get("VLLM_MAX_MODEL_LEN", "16384")

        cmd = [
            "vllm", "serve", model,
            "--host", "0.0.0.0",
            "--port", "8000",
            "--api-key", api_key,
            "--max-model-len", str(max_len),
            "--served-model-name", model,
            "--uvicorn-log-level=info",
            "--enforce-eager",
        ]
        print("launching:", " ".join(cmd[:6] + ["..."]), flush=True)
        self.process = subprocess.Popen(cmd)

    @modal.exit()
    def stop(self):
        self.process.terminate()


@app.function(image=modal.Image.debian_slim().pip_install("fastapi[standard]"), timeout=30)
@modal.fastapi_endpoint(method="GET")
def healthz():
    return {"status": "ok"}
