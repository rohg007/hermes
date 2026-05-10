package com.bitnetrn;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

final class BitNetDownloadManager {
  private final File modelDir;
  private final File metadataFile;
  private final Object metadataLock = new Object();
  private final ExecutorService executor = Executors.newFixedThreadPool(2);
  private final ConcurrentHashMap<String, Job> jobs = new ConcurrentHashMap<>();

  BitNetDownloadManager(Context context) {
    File bitnetDir = new File(context.getFilesDir(), "bitnet");
    modelDir = new File(bitnetDir, "models");
    metadataFile = new File(bitnetDir, "models.json");
    if (!modelDir.exists()) {
      modelDir.mkdirs();
    }
  }

  String start(String requestJson) throws Exception {
    JSONObject request = new JSONObject(requestJson);
    String id = request.getString("id");
    String url = request.getString("url");
    String fileName = request.optString("fileName", id);
    String checksum = request.optString("checksumSha256", "");
    String source = request.optString("source", url);

    JSONObject existing = findRecord(id);
    Job job = new Job(UUID.randomUUID().toString(), id);
    jobs.put(job.jobId, job);

    if (existing != null && new File(existing.getString("path")).exists()) {
      job.status = "completed";
      job.result = existing;
      job.receivedBytes = existing.optLong("sizeBytes", 0);
      job.totalBytes = job.receivedBytes;
      return job.jobId;
    }

    job.future = executor.submit(() -> {
      try {
        job.status = "downloading";
        JSONObject result = download(id, url, fileName, checksum, source, job);
        job.result = result;
        job.status = "completed";
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        job.status = "cancelled";
        job.error = "Download cancelled.";
      } catch (Exception error) {
        job.status = job.cancelled.get() ? "cancelled" : "failed";
        job.error = error.getMessage();
      }
    });

    return job.jobId;
  }

  String progress(String jobId) throws Exception {
    Job job = requireJob(jobId);
    JSONObject payload = new JSONObject();
    payload.put("jobId", job.jobId);
    payload.put("modelId", job.modelId);
    payload.put("receivedBytes", job.receivedBytes);
    if (job.totalBytes > 0) {
      payload.put("totalBytes", job.totalBytes);
    }
    payload.put("status", job.status);
    if (job.error != null) {
      payload.put("error", job.error);
    }
    if ("failed".equals(job.status) || "cancelled".equals(job.status)) {
      jobs.remove(jobId);
    }
    return payload.toString();
  }

  String await(String jobId) throws Exception {
    Job job = requireJob(jobId);
    try {
      Future<?> future = job.future;
      if (future != null) {
        future.get();
      }
      if (!"completed".equals(job.status)) {
        throw new IllegalStateException(job.error != null ? job.error : "Download did not complete.");
      }
      return job.result.toString();
    } finally {
      jobs.remove(jobId);
    }
  }

  void cancel(String jobId) throws Exception {
    Job job = requireJob(jobId);
    job.cancelled.set(true);
    Future<?> future = job.future;
    if (future != null) {
      future.cancel(true);
    }
    job.status = "cancelled";
    jobs.remove(jobId);
  }

  String list() throws Exception {
    return readMetadata().toString();
  }

  boolean delete(String modelId) throws Exception {
    boolean deleted = false;
    JSONArray next = new JSONArray();
    JSONArray models = readMetadata();
    for (int i = 0; i < models.length(); i++) {
      JSONObject model = models.getJSONObject(i);
      if (modelId.equals(model.getString("id"))) {
        File file = new File(model.getString("path"));
        if (file.exists()) {
          deleted = file.delete();
        } else {
          deleted = true;
        }
      } else {
        next.put(model);
      }
    }
    writeMetadata(next);
    return deleted;
  }

  double diskUsage() {
    return diskUsage(modelDir);
  }

  private JSONObject download(
    String id,
    String url,
    String fileName,
    String checksum,
    String source,
    Job job
  ) throws Exception {
    File destination = new File(modelDir, sanitize(fileName));
    File partial = new File(modelDir, sanitize(fileName) + ".part");

    long existingBytes = partial.exists() ? partial.length() : 0L;
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setConnectTimeout(15000);
    connection.setReadTimeout(30000);
    connection.setRequestProperty("Accept-Encoding", "identity");
    if (existingBytes > 0) {
      connection.setRequestProperty("Range", "bytes=" + existingBytes + "-");
    }

    int responseCode = connection.getResponseCode();
    boolean append = responseCode == HttpURLConnection.HTTP_PARTIAL;
    if (responseCode != HttpURLConnection.HTTP_OK && responseCode != HttpURLConnection.HTTP_PARTIAL) {
      throw new IllegalStateException("HTTP " + responseCode + " while downloading " + url);
    }
    if (!append && partial.exists()) {
      partial.delete();
      existingBytes = 0L;
    }

    long contentLength = connection.getContentLengthLong();
    job.receivedBytes = existingBytes;
    job.totalBytes = contentLength > 0 ? existingBytes + contentLength : 0L;

    try (
      BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
      FileOutputStream output = new FileOutputStream(partial, append)
    ) {
      byte[] buffer = new byte[1024 * 256];
      int read;
      while ((read = input.read(buffer)) != -1) {
        if (job.cancelled.get() || Thread.currentThread().isInterrupted()) {
          throw new InterruptedException();
        }
        output.write(buffer, 0, read);
        job.receivedBytes += read;
      }
    } finally {
      connection.disconnect();
    }

    job.status = "validating";
    if (destination.exists() && !destination.delete()) {
      throw new IllegalStateException("Unable to replace existing model file " + destination.getAbsolutePath());
    }
    if (!partial.renameTo(destination)) {
      throw new IllegalStateException("Unable to finalize model file " + destination.getAbsolutePath());
    }

    String sha256 = "";
    if (checksum != null && !checksum.isEmpty()) {
      sha256 = sha256(destination);
      if (!checksum.equalsIgnoreCase(sha256)) {
        destination.delete();
        throw new IllegalStateException("BITNET_CHECKSUM_MISMATCH: expected " + checksum + " but got " + sha256);
      }
    }

    String now = Instant.now().toString();
    JSONObject record = new JSONObject();
    record.put("id", id);
    record.put("path", destination.getAbsolutePath());
    record.put("source", source);
    record.put("fileName", fileName);
    record.put("sizeBytes", destination.length());
    if (!sha256.isEmpty()) {
      record.put("checksumSha256", sha256);
    } else if (checksum != null && !checksum.isEmpty()) {
      record.put("checksumSha256", checksum);
    }
    record.put("createdAt", now);
    record.put("updatedAt", now);
    upsertRecord(record);
    return record;
  }

  private Job requireJob(String jobId) {
    Job job = jobs.get(jobId);
    if (job == null) {
      throw new IllegalArgumentException("Unknown BitNet download job " + jobId);
    }
    return job;
  }

  private JSONObject findRecord(String id) throws Exception {
    JSONArray models = readMetadata();
    for (int i = 0; i < models.length(); i++) {
      JSONObject model = models.getJSONObject(i);
      if (id.equals(model.getString("id"))) {
        return model;
      }
    }
    return null;
  }

  private void upsertRecord(JSONObject record) throws Exception {
    synchronized (metadataLock) {
      JSONArray models = readMetadata();
      JSONArray next = new JSONArray();
      for (int i = 0; i < models.length(); i++) {
        JSONObject model = models.getJSONObject(i);
        if (!record.getString("id").equals(model.getString("id"))) {
          next.put(model);
        }
      }
      next.put(record);
      writeMetadata(next);
    }
  }

  private JSONArray readMetadata() throws Exception {
    synchronized (metadataLock) {
      if (!metadataFile.exists()) {
        return new JSONArray();
      }
      StringBuilder builder = new StringBuilder();
      try (FileInputStream input = new FileInputStream(metadataFile)) {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
          builder.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
        }
      }
      if (builder.length() == 0) {
        return new JSONArray();
      }
      return new JSONArray(builder.toString());
    }
  }

  private void writeMetadata(JSONArray metadata) throws Exception {
    synchronized (metadataLock) {
      File parent = metadataFile.getParentFile();
      if (parent != null && !parent.exists()) {
        parent.mkdirs();
      }
      try (OutputStreamWriter writer = new OutputStreamWriter(
        new FileOutputStream(metadataFile, false),
        StandardCharsets.UTF_8
      )) {
        writer.write(metadata.toString());
      }
    }
  }

  private static String sanitize(String name) {
    return name.replaceAll("[^a-zA-Z0-9._-]", "_");
  }

  private static String sha256(File file) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (FileInputStream input = new FileInputStream(file)) {
      byte[] buffer = new byte[1024 * 256];
      int read;
      while ((read = input.read(buffer)) != -1) {
        digest.update(buffer, 0, read);
      }
    }
    StringBuilder builder = new StringBuilder();
    for (byte b : digest.digest()) {
      builder.append(String.format(Locale.US, "%02x", b));
    }
    return builder.toString();
  }

  private static long diskUsage(File file) {
    if (!file.exists()) {
      return 0L;
    }
    if (file.isFile()) {
      return file.length();
    }
    long total = 0L;
    File[] children = file.listFiles();
    if (children != null) {
      for (File child : children) {
        total += diskUsage(child);
      }
    }
    return total;
  }

  private static final class Job {
    final String jobId;
    final String modelId;
    final AtomicBoolean cancelled = new AtomicBoolean(false);
    volatile String status = "queued";
    volatile long receivedBytes = 0L;
    volatile long totalBytes = 0L;
    volatile String error;
    volatile JSONObject result;
    volatile Future<?> future;

    Job(String jobId, String modelId) {
      this.jobId = jobId;
      this.modelId = modelId;
    }
  }
}
