#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_BITNET_CPP_DIR="$(node -e 'const fs=require("fs"),path=require("path"); const p=path.join(process.cwd(),"bitnet.config.json"); if(fs.existsSync(p)){const c=JSON.parse(fs.readFileSync(p,"utf8")); if(c.bitnetPath) process.stdout.write(path.resolve(path.dirname(p), c.bitnetPath));}' 2>/dev/null || true)"
CONFIG_ENABLE_GPU="$(node -e 'const fs=require("fs"),path=require("path"); const p=path.join(process.cwd(),"bitnet.config.json"); if(fs.existsSync(p)){const c=JSON.parse(fs.readFileSync(p,"utf8")); if(c.enableGPU!==undefined) process.stdout.write(String(c.enableGPU));}' 2>/dev/null || true)"
CONFIG_WEB_THREADS="$(node -e 'const fs=require("fs"),path=require("path"); const p=path.join(process.cwd(),"bitnet.config.json"); if(fs.existsSync(p)){const c=JSON.parse(fs.readFileSync(p,"utf8")); if(c.webThreads!==undefined) process.stdout.write(String(c.webThreads));}' 2>/dev/null || true)"
CONFIG_WEB_THREAD_COUNT="$(node -e 'const fs=require("fs"),path=require("path"); const p=path.join(process.cwd(),"bitnet.config.json"); if(fs.existsSync(p)){const c=JSON.parse(fs.readFileSync(p,"utf8")); if(c.webThreadCount!==undefined) process.stdout.write(String(c.webThreadCount));}' 2>/dev/null || true)"
BITNET_CPP_DIR="${BITNET_CPP_DIR:-${CONFIG_BITNET_CPP_DIR:-${ROOT_DIR}/third_party/BitNet}}"
BUILD_DIR="${BUILD_DIR:-${ROOT_DIR}/build/web-wasm}"
ENABLE_GPU="${ENABLE_GPU:-${CONFIG_ENABLE_GPU:-false}}"
if [[ -z "${WASM_PTHREAD_POOL_SIZE:-}" ]]; then
  if [[ "${CONFIG_WEB_THREADS}" == "true" ]]; then
    WASM_PTHREAD_POOL_SIZE="${CONFIG_WEB_THREAD_COUNT:-4}"
  else
    WASM_PTHREAD_POOL_SIZE="0"
  fi
fi
WEB_PUBLIC_DIR="${WEB_PUBLIC_DIR:-${ROOT_DIR}/example/public}"
export EM_CACHE="${EM_CACHE:-${ROOT_DIR}/build/emscripten-cache}"
WASM_PATCH_FILE="${ROOT_DIR}/patches/bitnet-wasm-scalar-fallback.patch"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake was not found. Install and activate Emscripten before building BitNet WASM." >&2
  exit 1
fi

mkdir -p "${EM_CACHE}"

if [[ "${BITNET_APPLY_WASM_PATCH:-true}" == "true" && -f "${WASM_PATCH_FILE}" ]]; then
  if ! grep -q "BitNet RN WASM scalar fallback" "${BITNET_CPP_DIR}/src/ggml-bitnet-mad.cpp"; then
    patch -d "${BITNET_CPP_DIR}" -p1 < "${WASM_PATCH_FILE}"
  fi
fi

emcmake cmake -S "${ROOT_DIR}/web" -B "${BUILD_DIR}" \
  -DBITNET_CPP_DIR="${BITNET_CPP_DIR}" \
  -DENABLE_GPU="${ENABLE_GPU}" \
  -DWASM_PTHREAD_POOL_SIZE="${WASM_PTHREAD_POOL_SIZE}"

cmake --build "${BUILD_DIR}" --config Release

echo "Built BitNet WASM artifacts in ${BUILD_DIR}"

JS_ARTIFACT="$(find "${BUILD_DIR}" -name 'bitnet_wasm.js' -print -quit)"
if [[ -z "${JS_ARTIFACT}" ]]; then
  echo "Could not find bitnet_wasm.js in ${BUILD_DIR}" >&2
  exit 1
fi

mkdir -p "${WEB_PUBLIC_DIR}"
find "${BUILD_DIR}" -name 'bitnet_wasm.*' -type f -exec cp {} "${WEB_PUBLIC_DIR}/" \;

echo "Copied BitNet WASM artifacts to ${WEB_PUBLIC_DIR}"
echo "Run the web example with: cd ${ROOT_DIR}/example && yarn web"
