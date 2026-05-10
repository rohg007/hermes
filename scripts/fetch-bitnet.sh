#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "${ROOT_DIR}/scripts/bitnet-setup.js" --dir "${ROOT_DIR}/third_party/BitNet" "$@"
