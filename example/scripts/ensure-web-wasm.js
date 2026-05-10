#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..', '..');
const publicDir = path.resolve(__dirname, '..', 'public');
const jsArtifact = path.join(publicDir, 'bitnet_wasm.js');
const wasmArtifact = path.join(publicDir, 'bitnet_wasm.wasm');
const buildScript = path.join(rootDir, 'scripts', 'build-web-wasm.sh');

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

if (fs.existsSync(jsArtifact) && fs.existsSync(wasmArtifact)) {
  console.log('[bitnet] Web WASM runtime is ready.');
  process.exit(0);
}

if (!fs.existsSync(buildScript)) {
  console.error(`[bitnet] Missing Web WASM build script: ${buildScript}`);
  process.exit(1);
}

if (!commandExists('emcmake')) {
  console.error(
    '[bitnet] Web needs Emscripten for the first WASM build. Install/activate Emscripten, then rerun `yarn web`.'
  );
  console.error('[bitnet] Android and iOS do not require Emscripten.');
  process.exit(1);
}

console.log('[bitnet] Web WASM runtime is missing. Building it once...');
const result = spawnSync('bash', [buildScript], {
  cwd: rootDir,
  env: { ...process.env, WEB_PUBLIC_DIR: publicDir },
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[bitnet] Failed to start Web WASM build: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`[bitnet] Web WASM build failed with exit code ${result.status}.`);
  process.exit(result.status ?? 1);
}
