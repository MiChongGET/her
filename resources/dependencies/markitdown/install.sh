#!/bin/sh
set -eu
# Validated target: macOS arm64, CPython 3.13.13, uv 0.11.16.
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'This lock is validated only for macOS arm64.' >&2; exit 1; }
MD_LOCK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MD_RUNTIME_ROOT="$HOME/.local/share/her/dependencies/markitdown-0.1.8"
if [ ! -d "$MD_RUNTIME_ROOT" ]; then uv venv --python 3.13.13 "$MD_RUNTIME_ROOT"; fi
UV_HTTP_TIMEOUT=180 UV_CONCURRENT_DOWNLOADS=2 uv pip install --require-hashes \
  --python "$MD_RUNTIME_ROOT/bin/python" -r "$MD_LOCK_DIR/requirements-runtime.lock"
uv pip check --python "$MD_RUNTIME_ROOT/bin/python"
"$MD_RUNTIME_ROOT/bin/python" -I -c 'from importlib.metadata import version; print({p: version(p) for p in ("markitdown-mcp", "markitdown", "pandas", "azure-ai-contentunderstanding", "lxml")})'
echo "Installed $MD_RUNTIME_ROOT/bin/markitdown-mcp; keep the uv managed base interpreter installed."
