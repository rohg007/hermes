#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { setup } = require('./bitnet-setup');

function loadConfig() {
  const configPath = path.join(process.cwd(), 'bitnet.config.json');
  if (!fs.existsSync(configPath)) {
    return { configPath, config: null };
  }
  return {
    configPath,
    config: JSON.parse(fs.readFileSync(configPath, 'utf8')),
  };
}

function resolveFromConfig(configPath, value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value);
}

function doctor(options = {}) {
  const setExitCode = options.setExitCode !== false;
  const { configPath, config } = loadConfig();
  const candidates = [
    process.env.BITNET_CPP_DIR,
    config ? resolveFromConfig(configPath, config.bitnetPath) : '',
    path.join(process.cwd(), 'third_party', 'BitNet'),
    path.resolve(process.cwd(), '..', 'BitNet'),
  ].filter(Boolean);

  const bitnetDir = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'CMakeLists.txt'))
  );
  const completeBitnetDir = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'CMakeLists.txt')) &&
    fs.existsSync(path.join(candidate, 'include', 'bitnet-lut-kernels.h'))
  );

  console.log('[bitnet] Doctor');
  console.log(`  config: ${config ? configPath : 'not found'}`);
  console.log(
    `  BitNet.cpp: ${
      completeBitnetDir || (bitnetDir ? `${bitnetDir} (incomplete: missing include/bitnet-lut-kernels.h)` : 'not found')
    }`
  );
  console.log(`  GPU: ${config?.enableGPU ? 'enabled in config' : process.env.ENABLE_GPU ? 'enabled by env' : 'disabled'}`);
  console.log(`  stub: ${config?.enableStub ? 'enabled in config' : process.env.BITNET_RN_ENABLE_STUB ? 'enabled by env' : 'disabled'}`);

  let ok = true;
  if (!bitnetDir) {
    console.log('');
    console.log('Run `yarn bitnet:init` in this repo, or `yarn bitnet init` in an app.');
    ok = false;
  } else if (!completeBitnetDir) {
    console.log('');
    console.log('Run `yarn bitnet:init --update` to prepare the mobile include layout.');
    ok = false;
  }
  if (!ok && setExitCode) {
    process.exitCode = 1;
  }
  return ok;
}

function init(rest) {
  const result = setup(rest);
  console.log('');
  const ok = doctor({ setExitCode: false });
  if (!ok) {
    throw new Error('BitNet setup finished, but doctor checks still failed.');
  }
  console.log('');
  console.log('[bitnet] Ready. Next step:');
  console.log('  Demo app: cd example && yarn android');
  console.log('  iOS demo: cd example && yarn ios');
  console.log('  Web demo: cd example && yarn web');
  console.log('');
  console.log('[bitnet] App usage:');
  console.log('  const model = await BitNet.load();');
  return result;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'init') {
    init(rest);
    return;
  }
  if (command === 'setup') {
    setup(rest);
    return;
  }
  if (command === 'doctor') {
    doctor();
    return;
  }
  if (command === '-h' || command === '--help') {
    console.log(`Usage:
  bitnet init [options]    setup + doctor
  bitnet setup [options]   setup only
  bitnet doctor
`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`[bitnet] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
