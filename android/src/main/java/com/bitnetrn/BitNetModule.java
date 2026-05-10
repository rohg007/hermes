package com.bitnetrn;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class BitNetModule extends NativeBitNetSpec {
  public static final String NAME = "BitNet";
  private static final int DEFAULT_MAX_TOKENS = 512;
  private static final int NATIVE_EXECUTOR_THREADS = 4;

  static {
    System.loadLibrary("bitnetrn");
  }

  // nextTokenBatch polls frequently during streaming. Keep native promise work
  // bounded so a busy JS/RN runtime cannot grow an unbounded cached thread pool.
  private final ExecutorService executor = Executors.newFixedThreadPool(NATIVE_EXECUTOR_THREADS);
  private final BitNetDownloadManager downloads;

  public BitNetModule(ReactApplicationContext reactContext) {
    super(reactContext);
    downloads = new BitNetDownloadManager(reactContext);
  }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  @Override
  protected Map<String, Object> getTypedExportedConstants() {
    Map<String, Object> constants = new HashMap<>();
    constants.put("nativeVersion", "0.1.0");
    constants.put("maxConcurrencyPerModel", 1);
    return constants;
  }

  @Override
  public void getRuntimeCapabilities(Promise promise) {
    runAsync(promise, BitNetModule::nativeGetRuntimeCapabilities);
  }

  @Override
  public void loadModel(String modelPath, String optionsJson, Promise promise) {
    runAsync(promise, () -> {
      JSONObject options = new JSONObject(optionsJson);
      return nativeLoadModel(
        modelPath,
        options.optString("id", modelPath),
        options.optString("runtime", "cpu"),
        options.optInt("contextSize", 2048),
        options.optInt("threads", 0),
        options.optBoolean("keepInMemory", true)
      );
    });
  }

  @Override
  public void unloadModel(String modelHandle, Promise promise) {
    runAsyncVoid(promise, () -> nativeUnloadModel(modelHandle));
  }

  @Override
  public void startGeneration(String modelHandle, String paramsJson, Promise promise) {
    runAsync(promise, () -> {
      JSONObject params = new JSONObject(paramsJson);
      return nativeStartGeneration(
        modelHandle,
        params.getString("prompt"),
        params.optString("systemPrompt", ""),
        params.optString("chatTemplate", ""),
        params.optDouble("temperature", 0.8),
        params.optInt("topK", 40),
        params.optDouble("topP", 0.95),
        params.optInt("maxTokens", DEFAULT_MAX_TOKENS),
        params.optInt("seed", -1),
        params.optDouble("repeatPenalty", 1.1),
        params.optBoolean("useChatTemplate", false)
      );
    });
  }

  @Override
  public void nextTokenBatch(String generationHandle, double maxTokens, double timeoutMs, Promise promise) {
    runAsync(promise, () -> nativeNextTokenBatch(generationHandle, (int) maxTokens, (int) timeoutMs));
  }

  @Override
  public void cancelGeneration(String generationHandle, Promise promise) {
    runAsyncVoid(promise, () -> nativeCancelGeneration(generationHandle));
  }

  @Override
  public void downloadModel(String requestJson, Promise promise) {
    runAsync(promise, () -> downloads.start(requestJson));
  }

  @Override
  public void getDownloadProgress(String jobHandle, Promise promise) {
    runAsync(promise, () -> downloads.progress(jobHandle));
  }

  @Override
  public void awaitDownload(String jobHandle, Promise promise) {
    runAsync(promise, () -> downloads.await(jobHandle));
  }

  @Override
  public void cancelDownload(String jobHandle, Promise promise) {
    runAsyncVoid(promise, () -> downloads.cancel(jobHandle));
  }

  @Override
  public void listModels(Promise promise) {
    runAsync(promise, downloads::list);
  }

  @Override
  public void deleteModel(String modelId, Promise promise) {
    runAsync(promise, () -> downloads.delete(modelId));
  }

  @Override
  public void getDiskUsage(Promise promise) {
    runAsync(promise, downloads::diskUsage);
  }

  private interface ThrowingSupplier<T> {
    T get() throws Exception;
  }

  private interface ThrowingRunnable {
    void run() throws Exception;
  }

  private <T> void runAsync(Promise promise, ThrowingSupplier<T> supplier) {
    executor.execute(() -> {
      try {
        promise.resolve(supplier.get());
      } catch (Throwable error) {
        promise.reject("BITNET_NATIVE", error);
      }
    });
  }

  private void runAsyncVoid(Promise promise, ThrowingRunnable runnable) {
    executor.execute(() -> {
      try {
        runnable.run();
        promise.resolve(null);
      } catch (Throwable error) {
        promise.reject("BITNET_NATIVE", error);
      }
    });
  }

  private static native String nativeGetRuntimeCapabilities();
  private static native String nativeLoadModel(
    String modelPath,
    String modelId,
    String runtime,
    int contextSize,
    int threads,
    boolean keepInMemory
  );
  private static native void nativeUnloadModel(String modelHandle);
  private static native String nativeStartGeneration(
    String modelHandle,
    String prompt,
    String systemPrompt,
    String chatTemplate,
    double temperature,
    int topK,
    double topP,
    int maxTokens,
    int seed,
    double repeatPenalty,
    boolean useChatTemplate
  );
  private static native String nativeNextTokenBatch(String generationHandle, int maxTokens, int timeoutMs);
  private static native void nativeCancelGeneration(String generationHandle);
}
