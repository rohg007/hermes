#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const exampleRoot = path.resolve(__dirname, '..');
const reactNativeCli = path.join(exampleRoot, 'node_modules', 'react-native', 'cli.js');
const localGradleHome = path.join(exampleRoot, 'android', '.gradle-user');
const homebrewJdk17 = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';

const rawArgs = process.argv.slice(2);
const passthroughArgs = [];
let enableGpu = false;

for (const arg of rawArgs) {
  if (arg === '--gpu') {
    enableGpu = true;
    continue;
  }
  if (arg === '--cpu') {
    enableGpu = false;
    continue;
  }
  passthroughArgs.push(arg);
}

function appendGradleParam(args, param) {
  const extraParamsIndex = args.indexOf('--extra-params');
  if (extraParamsIndex >= 0 && args[extraParamsIndex + 1]) {
    args[extraParamsIndex + 1] = `${args[extraParamsIndex + 1]} ${param}`;
    return;
  }

  const inlineExtraParamsIndex = args.findIndex((arg) => arg.startsWith('--extra-params='));
  if (inlineExtraParamsIndex >= 0) {
    args[inlineExtraParamsIndex] = `${args[inlineExtraParamsIndex]} ${param}`;
    return;
  }

  args.push('--extra-params', param);
}

const args = ['run-android', ...passthroughArgs];

if (!args.includes('--no-packager')) {
  args.push('--no-packager');
}

if (enableGpu) {
  appendGradleParam(args, '-PENABLE_GPU=true');
}

const env = {
  ...process.env,
  GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || localGradleHome,
};

if (enableGpu) {
  env.ENABLE_GPU = 'true';
}

if (!env.JAVA_HOME && fs.existsSync(path.join(homebrewJdk17, 'bin', 'java'))) {
  env.JAVA_HOME = homebrewJdk17;
}

fs.mkdirSync(env.GRADLE_USER_HOME, { recursive: true });

console.log('[BitNetExample] Using existing Metro server; run `yarn start` in another terminal if it is not already running.');
console.log(`[BitNetExample] GRADLE_USER_HOME=${env.GRADLE_USER_HOME}`);
if (enableGpu) {
  console.log('[BitNetExample] Android GPU build enabled (-PENABLE_GPU=true). CPU remains the safe fallback for runtime="auto".');
}

const result = spawnSync(process.execPath, [reactNativeCli, ...args], {
  cwd: exampleRoot,
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
