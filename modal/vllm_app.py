"""
Modal app: persistent vLLM server — Qwen/Qwen3-VL-8B-Instruct-FP8 (A100-40GB).

Fresh implementation of the pattern this repo originally tried in November
(never granted GPU capacity then; rewritten for the rewrite pipeline).
The JS side talks to it through src/providers/modalVllm.js (OpenAI-compatible
/v1/chat/completions with an Authorization: Bearer token).

Auth model
----------
The `florence-api` Modal secret holds MODAL_API_SECRET (created Nov 2026).
The vLLM server is launched with `--api-key $MODAL_API_SECRET`; the JS client
must send the SAME value as VLLM_API_TOKEN from .env.

Deploy
------
    python -m modal deploy modal/vllm_app.py

The deploy prints a URL like:
    https://<workspace>--document-vlm-8b--server.<region>.modal.run
Copy it into .env as VLLM_ENDPOINT_URL (bare origin — no /v1 suffix) and
restart the UI/CLI. The server scales to zero after 300 s idle.
"""

import os
import subprocess
import sys
import time
import urllib.request

import modal

APP_NAME = "document-vlm-8b"
MODEL = "Qwen/Qwen3-VL-8B-Instruct-FP8"
# vLLM must support the qwen3_vl architecture; keep this reasonably current.
VLLM_IMAGE_TAG = "vllm/vllm-openai:v0.11.1"
VLLM_PORT = 8000

app = modal.App(APP_NAME)

# Bake the model into the image so cold starts don't re-download ~9 GB every
# time. The HF download happens at image BUILD time (cached by Modal).
vllm_image = (
    modal.Image.from_registry(VLLM_IMAGE_TAG, add_python="3.12")
    .entrypoint([])  # clear the image's `vllm` entrypoint so Modal can run its own
    .run_commands(f"huggingface-cli download {MODEL}")
)


@app.function(image=modal.Image.debian_slim().pip_install("fastapi[standard]"), timeout=30)
@modal.fastapi_endpoint(method="GET")
def healthz():
    return {"status": "ok", "app": APP_NAME, "model": MODEL}


@app.server(
    image=vllm_image,
    gpu="A100-40GB",
    scaledown_window=300,
    startup_timeout=900,
    routing_region="us-east",
    target_concurrency=100,
    unauthenticated=True,  # auth enforced inside vLLM via --api-key
    secrets=[modal.Secret.from_name("florence-api")],
)
class Server:
    @modal.enter()
    def start(self):
        model = os.environ.get("VLLM_MODEL", MODEL)
        api_key = os.environ["MODAL_API_SECRET"]
        max_len = os.environ.get("VLLM_MAX_MODEL_LEN", "16384")

        cmd = [
            "vllm", "serve", model,
            "--host", "0.0.0.0",
            "--port", str(VLLM_PORT),
            "--api-key", api_key,
            "--max-model-len", str(max_len),
            "--served-model-name", model,
            "--uvicorn-log-level=info",
        ]
        print(f"launching: vllm serve {model} --host 0.0.0.0 --port {VLLM_PORT} --max-model-len {max_len} (api key hidden)", flush=True)
        self.process = subprocess.Popen(cmd)
        # wait for vllm to accept connections before Modal marks the server ready
        deadline = time.time() + 600
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"vllm exited early: code={self.process.returncode}")
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{VLLM_PORT}/health", timeout=3)
                print("vllm is up", flush=True)
                return
            except Exception:
                time.sleep(2)
        raise RuntimeError("vllm did not come up within 600s")

    @modal.exit()
    def stop(self):
        try:
            self.process.terminate()
            self.process.wait(timeout=30)
        except Exception as e:
            print(f"shutdown warning: {e}", file=sys.stderr, flush=True)
