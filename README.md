# React Native BitNet SDK

Production-ready local BitNet.cpp inference for React Native and Web: CPU-first reliability, native streaming, and a tiny first-token API.

The SDK is designed to avoid adding overhead on top of BitNet.cpp rather than attempting to optimize the inference engine itself.

## Quick Start

1. Install dependencies.
2. Set up the native runtime.
3. Run an example app.

```sh
yarn install
yarn bitnet:init
cd example && yarn android
```

iOS uses the same setup: `cd example && yarn ios`. Web uses `cd example && yarn web`; the example builds the WASM runtime automatically when it is missing.

The example handles the full flow: recommended model download, local cache, model load, streaming output, metrics, Stop, and Reload. First token typically appears within a few seconds after model load on modern devices.

## Use In Your App

```sh
yarn add @bitnet/react-native
yarn bitnet:init
```

Most apps should use `chat()` with a `messages` array. Lower-level APIs are available for advanced use cases.

React apps should use the hook:

```tsx
import { useBitNet } from '@bitnet/react-native';

function Chat() {
  const { ready, busy, statusText, chat } = useBitNet();

  async function send(prompt: string) {
    if (!ready || busy) {
      console.log(statusText);
      return;
    }
    for await (const token of chat({
      messages: [
        { role: 'system', content: 'You are concise and helpful.' },
        { role: 'user', content: prompt },
      ],
    })) {
      console.log(token);
    }
  }

  return null;
}
```

Outside React, load the model directly and call `model.chat()`:

```ts
import { BitNet, RECOMMENDED_BITNET_MODEL } from '@bitnet/react-native';

// Auto-downloads the recommended model if it is not cached yet.
const model = await BitNet.load(BitNet.modelId(RECOMMENDED_BITNET_MODEL));

for await (const token of model.chat({
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  console.log(token);
}
```

`BitNet.load()` with no arguments uses the same recommended model. Setup is a one-time project step; later launches reuse the cache.

## How It Works

- The model is downloaded once and cached locally.
- The cached GGUF is loaded into native memory.
- Tokenization, sampling, and decoding run in BitNet.cpp.
- JS receives small streamed text batches for display.

## Default Behavior

- Uses CPU by default.
- Selects thread count automatically.
- One generation can run per loaded model.
- SDK generation defaults to `maxTokens: 512`.
- The example app caps output at 128 tokens on Web and 64 tokens on mobile.
- Models stay loaded until `model.unload()`.
- Web inference runs inside a Web Worker.
- Needs no runtime config for the recommended model.

## Optional Controls

Skip this section for your first run.

### Generation Parameters

Optional parameters for advanced control:

```ts
const model = await BitNet.load();

for await (const token of model.chat({
  messages: [
    { role: 'system', content: 'Answer in one sentence.' },
    { role: 'user', content: 'What is BitNet?' },
  ],
  temperature: 0.2,
  maxTokens: 512,
  stopSequences: ['\nUser:'],
})) {
  console.log(token);
}
```

Supported generation params: `temperature`, `topK`, `topP`, `maxTokens`, `repeatPenalty`, `stopSequences`, `seed`, `abortSignal`, plus lower-level `prompt`, `promptMode`, `systemPrompt`, and `chatTemplate`.

### Download Progress

```ts
import { BitNet, RECOMMENDED_BITNET_MODEL, formatDownloadProgress } from '@bitnet/react-native';

await BitNet.load(BitNet.modelId(RECOMMENDED_BITNET_MODEL), {
  onProgress: (progress) => {
    console.log(formatDownloadProgress(progress));
  },
});
```

Pass `abortSignal`, `downloadTimeoutMs`, or `downloadStallTimeoutMs` when you need to cancel or bound the implicit download.

### Model Cache

The SDK owns the model cache, but apps can inspect and clean it:

```ts
import { BitNet, formatBytes } from '@bitnet/react-native';

const models = await BitNet.listModels();
const bytes = await BitNet.diskUsage();

console.log(`BitNet cache: ${formatBytes(bytes)}`);

if (models.length > 0) {
  await BitNet.deleteModel(models[0].id);
}
```

### Cancellation

```ts
const controller = new AbortController();

setTimeout(() => controller.abort(), 1000);

for await (const token of model.chat({
  messages: [{ role: 'user', content: 'Write one short paragraph' }],
  abortSignal: controller.signal,
})) {
  console.log(token);
}
```

### Metrics

```ts
model.onMetrics((metrics) => {
  console.log({
    runtimeUsed: metrics.runtimeUsed,
    promptTokens: metrics.promptTokens,
    tokensPerSecond: metrics.tokensPerSecond,
    latencyMs: metrics.latencyMs,
    memoryUsageMB: metrics.memoryUsageMB,
    threadCount: metrics.threadCount,
  });
});
```

`promptTokens` is optional. It is reported by the BitNet.cpp backend after native prompt tokenization and omitted by fallback backends that cannot compute it reliably.

## Requirements

- Android: `arm64-v8a`, minSdk 24, Android Studio NDK/CMake.
- iOS: arm64 device or simulator, iOS 13.4+, Xcode, CocoaPods.
- Web: WASM-compatible browser. Emscripten is needed only when building the local web runtime.
- Memory: budget roughly 2-4 GB free RAM and enough disk for the model plus a temporary download.

## Common Pitfalls

- `BITNET_NATIVE_UNAVAILABLE`: run `yarn bitnet:init`, then rebuild the app.
- `BITNET_MODEL_NOT_FOUND`: use `BitNet.load()` for the recommended model or run `BitNet.downloadModel(...)` before loading a custom model.
- `BITNET_MODEL_INCOMPATIBLE`: use a BitNet GGUF, not a generic GGUF.
- iOS pod/link errors: rerun `yarn bitnet:init`, then `cd example && yarn ios`.
- Web WASM missing: rerun `cd example && yarn web`. The example builds `bitnet_wasm.*` when needed.
- Gibberish output: verify the same model in upstream BitNet.cpp first. The SDK does not patch model/runtime regressions.

## Advanced

### Runtime Selection

The runtime API is available when you need it:

```ts
type Runtime = 'cpu' | 'gpu' | 'auto';
```

CPU is the production baseline. `auto` may use GPU only when the native capability detector marks that backend safe; otherwise it falls back to CPU before streaming begins. `gpu` explicitly requests GPU and throws `BITNET_RUNTIME_UNAVAILABLE` if the backend is not compiled, unavailable, or unsafe for the current model/platform.

```ts
const model = await BitNet.load(BitNet.modelId(RECOMMENDED_BITNET_MODEL), {
  runtime: 'cpu',
  contextSize: 2048,
  threads: 2,
});
```

### Setup Details

`yarn bitnet:init` runs setup and doctor checks. It clones `microsoft/BitNet` into `./third_party/BitNet` when missing, prepares the mobile include layout, writes `bitnet.config.json`, and prints the next command. Run it again only after changing native config or updating BitNet.cpp.

Native builds detect BitNet.cpp in this order:

1. explicit build setting (`-PbitnetCppDir` on Android, `BITNET_CPP_DIR` on iOS);
2. `bitnet.config.json` `bitnetPath`;
3. `./third_party/BitNet`;
4. `../BitNet`.

Diagnostics:

```sh
yarn bitnet:doctor
```

### Web Runtime

For the example, `yarn web` and `yarn build:web` build `example/public/bitnet_wasm.*` if the artifacts are missing.

Manual rebuilds are available for CI or recovery:

```sh
yarn build:web:wasm
```

Custom web apps can override the WASM loader:

```ts
import { configureBitNetWeb } from '@bitnet/react-native';

await configureBitNetWeb({ wasmModuleUrl: '/bitnet_wasm.js' });
```

Verbose Web worker/WASM diagnostics are off by default. Enable them only while debugging:

```ts
await configureBitNetWeb({ webDebug: true });
```

`webThreads` / `webThreadCount` are reserved for pthread-enabled WASM builds and should match the `bitnet.config.json` values used by `yarn build:web:wasm`.

### Stub Mode

Stub mode is a deterministic fake backend for CI and integration smoke tests. It exercises loading, streaming, cancellation, metrics, and UI wiring without running BitNet inference.

Use it for CI only. Do not ship it in production.

```sh
yarn android -- -PbitnetRnEnableStub=ON
BITNET_RN_ENABLE_STUB=1 pod install
```

### Design Decisions

- One recommended model: `microsoft/BitNet-b1.58-2B-4T-gguf` / `ggml-model-i2_s.gguf` keeps the baseline reproducible.
- No model conversion: conversion and quantization belong outside app startup.
- CPU default: BitNet.cpp is CPU-first and optimized with custom BitNet kernels.
- Conservative threading: BitNet decode is memory-bound, and mobile big.LITTLE CPUs can slow down when every core contends for memory bandwidth.
- Batched streaming: tokens are batched before crossing the RN/Web boundary to reduce UI overhead.
- One active generation: concurrent decoding contends for model weights, memory bandwidth, and KV-cache state.
- GPU as an extension point: GPU remains in the runtime API for future backend support, but it is optional and capability-gated because BitNet.cpp is CPU-first and GPU support is platform/model dependent.
- Android Vulkan guarded: the tested I2_S path can hit upstream ggml Vulkan aborts during context creation, so CPU reliability takes priority over exposing an unsafe GPU toggle.
- WebGPU deferred: Web detects WebGPU for future promotion, but the reliable web backend today is WASM CPU.
- No NPU runtime: BitNet.cpp does not expose a stable NPU path today.

## Repository Layout

```text
android/      Android TurboModule wrapper, JNI, download manager
cpp/          Shared C++ engine, runtime selection, native facade
ios/          ObjC++ wrapper and iOS download manager
scripts/      BitNet setup, doctor, and WASM build helpers
src/          TypeScript SDK
example/      Android/iOS/Web chat demo
web/          WASM worker runtime
```
