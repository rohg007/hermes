#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const exampleDir = path.resolve(__dirname, '..');
const iosDir = path.join(exampleDir, 'ios');
const podfile = path.join(iosDir, 'Podfile');
const podsManifest = path.join(iosDir, 'Pods', 'Manifest.lock');
const reactNativeBin = path.join(exampleDir, 'node_modules', '.bin', 'react-native');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || exampleDir,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

try {
  if (fs.existsSync(podfile) && !fs.existsSync(podsManifest)) {
    console.log('[bitnet] Installing iOS pods...');
    run('pod', ['install'], { cwd: iosDir });
  }

  run(reactNativeBin, ['run-ios', ...process.argv.slice(2)]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ENOENT') && message.includes('pod')) {
    console.error('[bitnet] CocoaPods was not found. Install it, then rerun `yarn ios`.');
  } else {
    console.error(`[bitnet] ${message}`);
  }
  process.exit(1);
}
