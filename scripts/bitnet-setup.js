#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_REPO = 'https://github.com/microsoft/BitNet.git';

function parseArgs(argv) {
  const args = {
    dir: path.join(process.cwd(), 'third_party', 'BitNet'),
    repo: DEFAULT_REPO,
    ref: process.env.BITNET_REF || '',
    enableGPU: false,
    enableStub: false,
    kernelModel: process.env.BITNET_KERNEL_MODEL || 'bitnet_b1_58-3B',
    writeConfig: true,
    update: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--dir':
        args.dir = path.resolve(requireValue(arg, next));
        index += 1;
        break;
      case '--repo':
        args.repo = requireValue(arg, next);
        index += 1;
        break;
      case '--ref':
        args.ref = requireValue(arg, next);
        index += 1;
        break;
      case '--enable-gpu':
        args.enableGPU = true;
        break;
      case '--stub':
        args.enableStub = true;
        break;
      case '--kernel-model':
        args.kernelModel = requireValue(arg, next);
        index += 1;
        break;
      case '--update':
        args.update = true;
        break;
      case '--no-config':
        args.writeConfig = false;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    stdio: options.stdio || 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function relativePath(from, to) {
  const relative = path.relative(from, to).replace(/\\/g, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function writeConfig(args) {
  const configPath = path.join(process.cwd(), 'bitnet.config.json');
  const existing = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  const next = {
    bitnetPath: relativePath(process.cwd(), args.dir),
    enableGPU: Boolean(args.enableGPU || existing.enableGPU),
    enableStub: Boolean(args.enableStub || existing.enableStub),
    web: {
      ...(existing.web || {}),
      wasmModuleUrl: existing.web?.wasmModuleUrl || '/bitnet_wasm.js',
    },
    ios: {
      ...(existing.ios || {}),
      bitnetStaticLib: existing.ios?.bitnetStaticLib || '',
      bitnetStaticLibs: existing.ios?.bitnetStaticLibs || [],
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return configPath;
}

function validateBitNetDir(dir) {
  const cmake = path.join(dir, 'CMakeLists.txt');
  if (!fs.existsSync(cmake)) {
    throw new Error(`BitNet.cpp checkout is incomplete: ${cmake} was not found.`);
  }
}

function prepareBitNetDir(dir, kernelModel) {
  const expectedHeader = path.join(dir, 'include', 'bitnet-lut-kernels.h');
  if (fs.existsSync(expectedHeader)) {
    return;
  }

  const presetDir = path.join(dir, 'preset_kernels', kernelModel);
  const presetHeader = path.join(presetDir, 'bitnet-lut-kernels-tl1.h');
  const presetConfig = path.join(presetDir, 'kernel_config_tl1.ini');
  const expectedConfig = path.join(dir, 'include', 'kernel_config.ini');
  if (fs.existsSync(presetHeader)) {
    fs.mkdirSync(path.dirname(expectedHeader), { recursive: true });
    fs.copyFileSync(presetHeader, expectedHeader);
    if (fs.existsSync(presetConfig)) {
      fs.copyFileSync(presetConfig, expectedConfig);
    }
    console.log(`[bitnet] Prepared mobile TL1 kernels from preset_kernels/${kernelModel}.`);
    return;
  }

  throw new Error(
    `BitNet.cpp checkout is missing ${expectedHeader}, and preset ${presetHeader} was not found. ` +
      'Run BitNet.cpp setup_env.py for your model or pass --kernel-model to a supported preset.'
  );
}

function ensurePreparedBitNetDir(dir, kernelModel) {
  prepareBitNetDir(dir, kernelModel);
  const expectedHeader = path.join(dir, 'include', 'bitnet-lut-kernels.h');
  if (!fs.existsSync(expectedHeader)) {
    throw new Error(`BitNet.cpp checkout is incomplete: ${expectedHeader} was not created.`);
  }
}

function setup(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const parent = path.dirname(args.dir);

  console.log('[bitnet] Preparing BitNet.cpp checkout');
  console.log(`[bitnet] Destination: ${args.dir}`);

  if (!commandExists('git')) {
    throw new Error('git was not found. Install git before running BitNet setup.');
  }

  fs.mkdirSync(parent, { recursive: true });

  if (fs.existsSync(path.join(args.dir, '.git'))) {
    console.log('[bitnet] Existing checkout found.');
    if (args.update) {
      run('git', ['fetch', '--tags', '--prune'], { cwd: args.dir });
      run('git', ['pull', '--ff-only'], { cwd: args.dir });
    }
  } else if (fs.existsSync(args.dir) && fs.readdirSync(args.dir).length > 0) {
    throw new Error(`${args.dir} exists but is not a git checkout. Move it or pass --dir.`);
  } else {
    run('git', ['clone', '--recursive', args.repo, args.dir]);
  }

  if (args.ref) {
    console.log(`[bitnet] Checking out ${args.ref}`);
    run('git', ['fetch', '--tags', '--prune'], { cwd: args.dir });
    run('git', ['checkout', args.ref], { cwd: args.dir });
  }

  run('git', ['submodule', 'update', '--init', '--recursive'], { cwd: args.dir });
  validateBitNetDir(args.dir);
  ensurePreparedBitNetDir(args.dir, args.kernelModel);

  let configPath = '';
  if (args.writeConfig) {
    configPath = writeConfig(args);
    console.log(`[bitnet] Wrote ${configPath}`);
  }

  console.log('');
  console.log('[bitnet] Setup complete.');
  console.log('  Verify: yarn bitnet:doctor');
  console.log('  Run demo: cd example && yarn android');
  console.log('');
  console.log('[bitnet] Notes:');
  console.log('  - Native builds auto-detect bitnet.config.json, BITNET_CPP_DIR, or ./third_party/BitNet.');
  console.log('  - This script does not download model weights.');
  console.log('  - iOS real inference builds the minimal BitNet.cpp/llama source set from the detected checkout.');

  return { bitnetDir: args.dir, configPath };
}

function printHelp() {
  console.log(`BitNet React Native setup

Usage:
  yarn bitnet:init [options]
  yarn bitnet:setup [options]
  yarn bitnet init [options]
  npx bitnet init [options]

Options:
  --dir <path>       BitNet.cpp checkout destination. Default: ./third_party/BitNet
  --repo <url>       Git repository URL. Default: ${DEFAULT_REPO}
  --ref <ref>        Optional tag, branch, or commit to checkout.
  --enable-gpu       Write enableGPU=true to bitnet.config.json.
  --stub             Write enableStub=true to bitnet.config.json for CI smoke tests.
  --kernel-model     Preset kernel model to prepare. Default: bitnet_b1_58-3B.
  --update           Fetch and fast-forward an existing checkout.
  --no-config        Clone only; do not write bitnet.config.json.
  -h, --help         Show this help.
`);
}

if (require.main === module) {
  try {
    setup();
  } catch (error) {
    console.error(`[bitnet] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { setup };
