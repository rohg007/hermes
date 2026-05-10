#import "BitNetDownloadManager.h"

#import <CommonCrypto/CommonDigest.h>

@interface BitNetDownloadJob : NSObject
@property(nonatomic, copy) NSString *jobId;
@property(nonatomic, copy) NSString *modelId;
@property(nonatomic, copy) NSString *url;
@property(nonatomic, copy) NSString *fileName;
@property(nonatomic, copy) NSString *source;
@property(nonatomic, copy) NSString *checksum;
@property(nonatomic, copy) NSString *status;
@property(nonatomic, copy) NSString *error;
@property(nonatomic, copy) NSString *partialPath;
@property(nonatomic, copy) NSString *destinationPath;
@property(nonatomic) int64_t receivedBytes;
@property(nonatomic) int64_t totalBytes;
@property(nonatomic, strong) NSMutableData *buffer;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, strong) NSFileHandle *fileHandle;
@property(nonatomic, strong) NSDictionary *result;
@property(nonatomic) dispatch_semaphore_t done;
@end

@implementation BitNetDownloadJob
@end

@interface BitNetDownloadManager ()
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSMutableDictionary<NSString *, BitNetDownloadJob *> *jobs;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, BitNetDownloadJob *> *tasks;
@property(nonatomic) dispatch_queue_t queue;
@property(nonatomic, copy) NSString *modelDir;
@property(nonatomic, copy) NSString *metadataPath;
@end

@implementation BitNetDownloadManager

- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.bitnetrn.downloads", DISPATCH_QUEUE_CONCURRENT);
    _jobs = [NSMutableDictionary new];
    _tasks = [NSMutableDictionary new];

    NSArray<NSURL *> *urls = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask];
    NSURL *root = [[urls firstObject] URLByAppendingPathComponent:@"BitNet" isDirectory:YES];
    NSURL *models = [root URLByAppendingPathComponent:@"models" isDirectory:YES];
    _modelDir = models.path;
    _metadataPath = [root URLByAppendingPathComponent:@"models.json"].path;

    [[NSFileManager defaultManager] createDirectoryAtPath:_modelDir withIntermediateDirectories:YES attributes:nil error:nil];
    [root setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];

    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
    configuration.HTTPMaximumConnectionsPerHost = 2;
    _session = [NSURLSession sessionWithConfiguration:configuration delegate:self delegateQueue:nil];
  }
  return self;
}

- (void)start:(NSString *)requestJson resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(self.queue, ^{
    NSError *error = nil;
    NSDictionary *request = [self parseObject:requestJson error:&error];
    if (request == nil) {
      reject(@"BITNET_INVALID_ARGUMENT", @"Invalid download request JSON.", error);
      return;
    }

    NSString *modelId = request[@"id"];
    NSString *url = request[@"url"];
    if (modelId.length == 0 || url.length == 0) {
      reject(@"BITNET_INVALID_ARGUMENT", @"Download request requires id and url.", nil);
      return;
    }

    BitNetDownloadJob *job = [BitNetDownloadJob new];
    job.jobId = [NSUUID UUID].UUIDString;
    job.modelId = modelId;
    job.url = url;
    job.fileName = request[@"fileName"] ?: modelId;
    job.source = request[@"source"] ?: url;
    job.checksum = request[@"checksumSha256"] ?: @"";
    job.status = @"queued";
    job.done = dispatch_semaphore_create(0);
    job.destinationPath = [self.modelDir stringByAppendingPathComponent:[self sanitize:job.fileName]];
    job.partialPath = [job.destinationPath stringByAppendingString:@".part"];

    NSDictionary *existing = [self findRecord:modelId];
    if (existing != nil && [[NSFileManager defaultManager] fileExistsAtPath:existing[@"path"]]) {
      job.status = @"completed";
      job.result = existing;
      job.receivedBytes = [existing[@"sizeBytes"] longLongValue];
      job.totalBytes = job.receivedBytes;
      @synchronized (self.jobs) {
        self.jobs[job.jobId] = job;
      }
      dispatch_semaphore_signal(job.done);
      resolve(job.jobId);
      return;
    }

    NSMutableURLRequest *urlRequest = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url]];
    [urlRequest setValue:@"identity" forHTTPHeaderField:@"Accept-Encoding"];
    int64_t existingBytes = [self fileSize:job.partialPath];
    if (existingBytes > 0) {
      [urlRequest setValue:[NSString stringWithFormat:@"bytes=%lld-", existingBytes] forHTTPHeaderField:@"Range"];
      job.receivedBytes = existingBytes;
    }

    job.task = [self.session dataTaskWithRequest:urlRequest];
    @synchronized (self.jobs) {
      self.jobs[job.jobId] = job;
      self.tasks[@(job.task.taskIdentifier)] = job;
    }
    job.status = @"downloading";
    [job.task resume];
    resolve(job.jobId);
  });
}

- (void)progress:(NSString *)jobId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  BitNetDownloadJob *job = [self job:jobId];
  if (job == nil) {
    reject(@"BITNET_INVALID_ARGUMENT", @"Unknown download job.", nil);
    return;
  }
  NSMutableDictionary *payload = [@{
    @"jobId": job.jobId,
    @"modelId": job.modelId,
    @"receivedBytes": @(job.receivedBytes),
    @"status": job.status ?: @"queued"
  } mutableCopy];
  if (job.totalBytes > 0) {
    payload[@"totalBytes"] = @(job.totalBytes);
  }
  if (job.error.length > 0) {
    payload[@"error"] = job.error;
  }
  resolve([self jsonString:payload]);
  if ([job.status isEqualToString:@"failed"] || [job.status isEqualToString:@"cancelled"]) {
    [self removeJob:job];
  }
}

- (void)await:(NSString *)jobId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(self.queue, ^{
    BitNetDownloadJob *job = [self job:jobId];
    if (job == nil) {
      reject(@"BITNET_INVALID_ARGUMENT", @"Unknown download job.", nil);
      return;
    }
    dispatch_semaphore_wait(job.done, DISPATCH_TIME_FOREVER);
    if (![job.status isEqualToString:@"completed"]) {
      [self removeJob:job];
      reject(@"BITNET_DOWNLOAD_FAILED", job.error ?: @"Download did not complete.", nil);
      return;
    }
    [self removeJob:job];
    resolve([self jsonString:job.result]);
  });
}

- (void)cancel:(NSString *)jobId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  BitNetDownloadJob *job = [self job:jobId];
  if (job == nil) {
    reject(@"BITNET_INVALID_ARGUMENT", @"Unknown download job.", nil);
    return;
  }
  job.status = @"cancelled";
  [job.task cancel];
  [job.fileHandle closeFile];
  job.fileHandle = nil;
  dispatch_semaphore_signal(job.done);
  [self removeJob:job];
  resolve(nil);
}

- (void)list:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve([self jsonString:[self readMetadata]]);
}

- (void)deleteModel:(NSString *)modelId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  NSMutableArray *next = [NSMutableArray new];
  BOOL deleted = NO;
  for (NSDictionary *record in [self readMetadata]) {
    if ([record[@"id"] isEqualToString:modelId]) {
      NSString *path = record[@"path"];
      if (path.length > 0) {
        [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
      }
      deleted = YES;
    } else {
      [next addObject:record];
    }
  }
  [self writeMetadata:next];
  resolve(@(deleted));
}

- (void)diskUsage:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve([self diskUsageAtPath:self.modelDir]);
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition disposition))completionHandler {
  BitNetDownloadJob *job = [self jobForTask:dataTask];
  NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
  if (job == nil || ![http isKindOfClass:[NSHTTPURLResponse class]]) {
    completionHandler(NSURLSessionResponseCancel);
    return;
  }

  BOOL partial = http.statusCode == 206;
  if (http.statusCode != 200 && http.statusCode != 206) {
    job.status = @"failed";
    job.error = [NSString stringWithFormat:@"HTTP %ld while downloading %@", (long)http.statusCode, job.url];
    completionHandler(NSURLSessionResponseCancel);
    return;
  }

  if (!partial) {
    [[NSFileManager defaultManager] removeItemAtPath:job.partialPath error:nil];
    job.receivedBytes = 0;
  }
  if (![[NSFileManager defaultManager] fileExistsAtPath:job.partialPath]) {
    [[NSData data] writeToFile:job.partialPath atomically:YES];
  }

  job.totalBytes = response.expectedContentLength > 0 ? job.receivedBytes + response.expectedContentLength : 0;
  job.fileHandle = [NSFileHandle fileHandleForWritingAtPath:job.partialPath];
  [job.fileHandle seekToEndOfFile];
  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask didReceiveData:(NSData *)data {
  BitNetDownloadJob *job = [self jobForTask:dataTask];
  if (job == nil || [job.status isEqualToString:@"cancelled"]) {
    return;
  }
  [job.fileHandle writeData:data];
  job.receivedBytes += data.length;
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  BitNetDownloadJob *job = [self jobForTask:(NSURLSessionDataTask *)task];
  if (job == nil) {
    return;
  }
  [job.fileHandle closeFile];
  job.fileHandle = nil;

  if ([job.status isEqualToString:@"failed"]) {
    dispatch_semaphore_signal(job.done);
    return;
  }
  if (error != nil) {
    job.status = [job.status isEqualToString:@"cancelled"] ? @"cancelled" : @"failed";
    job.error = error.localizedDescription;
    dispatch_semaphore_signal(job.done);
    return;
  }

  job.status = @"validating";
  if (job.checksum.length > 0) {
    NSString *actual = [self sha256:job.partialPath];
    if (![actual.lowercaseString isEqualToString:job.checksum.lowercaseString]) {
      [[NSFileManager defaultManager] removeItemAtPath:job.partialPath error:nil];
      job.status = @"failed";
      job.error = [NSString stringWithFormat:@"BITNET_CHECKSUM_MISMATCH: expected %@ but got %@", job.checksum, actual];
      dispatch_semaphore_signal(job.done);
      return;
    }
  }

  [[NSFileManager defaultManager] removeItemAtPath:job.destinationPath error:nil];
  NSError *moveError = nil;
  [[NSFileManager defaultManager] moveItemAtPath:job.partialPath toPath:job.destinationPath error:&moveError];
  if (moveError != nil) {
    job.status = @"failed";
    job.error = moveError.localizedDescription;
    dispatch_semaphore_signal(job.done);
    return;
  }

  NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
  NSString *now = [formatter stringFromDate:[NSDate date]];
  NSMutableDictionary *record = [@{
    @"id": job.modelId,
    @"path": job.destinationPath,
    @"source": job.source,
    @"fileName": job.fileName,
    @"sizeBytes": @([self fileSize:job.destinationPath]),
    @"createdAt": now,
    @"updatedAt": now
  } mutableCopy];
  if (job.checksum.length > 0) {
    record[@"checksumSha256"] = job.checksum;
  }
  [self upsertRecord:record];
  job.result = record;
  job.status = @"completed";
  dispatch_semaphore_signal(job.done);
}

- (BitNetDownloadJob *)job:(NSString *)jobId {
  @synchronized (self.jobs) {
    return self.jobs[jobId];
  }
}

- (BitNetDownloadJob *)jobForTask:(NSURLSessionTask *)task {
  @synchronized (self.jobs) {
    return self.tasks[@(task.taskIdentifier)];
  }
}

- (void)removeJob:(BitNetDownloadJob *)job {
  if (job == nil) {
    return;
  }
  @synchronized (self.jobs) {
    [self.jobs removeObjectForKey:job.jobId];
    if (job.task != nil) {
      [self.tasks removeObjectForKey:@(job.task.taskIdentifier)];
    }
  }
}

- (NSDictionary *)parseObject:(NSString *)json error:(NSError **)error {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
  return [payload isKindOfClass:[NSDictionary class]] ? payload : nil;
}

- (NSString *)jsonString:(id)object {
  if (object == nil) {
    return @"null";
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"null";
}

- (NSArray *)readMetadata {
  @synchronized (self) {
    NSData *data = [NSData dataWithContentsOfFile:self.metadataPath];
    if (data == nil) {
      return @[];
    }
    id payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![payload isKindOfClass:[NSArray class]]) {
      return @[];
    }
    return [self normalizeMetadataRecords:(NSArray *)payload];
  }
}

- (NSArray *)normalizeMetadataRecords:(NSArray *)records {
  NSMutableArray *normalized = [NSMutableArray new];
  BOOL changed = NO;
  NSFileManager *fileManager = [NSFileManager defaultManager];

  for (NSDictionary *record in records) {
    if (![record isKindOfClass:[NSDictionary class]]) {
      changed = YES;
      continue;
    }

    NSString *modelId = record[@"id"];
    NSString *fileName = record[@"fileName"];
    NSString *storedPath = record[@"path"];
    if (fileName.length == 0 && storedPath.length > 0) {
      fileName = storedPath.lastPathComponent;
    }
    if (modelId.length == 0 || fileName.length == 0) {
      changed = YES;
      continue;
    }

    NSString *currentPath = [self.modelDir stringByAppendingPathComponent:[self sanitize:fileName]];
    NSString *validPath = nil;
    if ([fileManager fileExistsAtPath:currentPath]) {
      validPath = currentPath;
    } else if (storedPath.length > 0 && [fileManager fileExistsAtPath:storedPath]) {
      validPath = storedPath;
    }

    if (validPath.length == 0) {
      changed = YES;
      continue;
    }

    NSMutableDictionary *nextRecord = [record mutableCopy];
    if (![nextRecord[@"path"] isEqualToString:validPath]) {
      nextRecord[@"path"] = validPath;
      changed = YES;
    }
    [normalized addObject:nextRecord];
  }

  if (changed) {
    [self writeMetadata:normalized];
  }
  return normalized;
}

- (void)writeMetadata:(NSArray *)records {
  @synchronized (self) {
    NSString *parent = [self.metadataPath stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:parent withIntermediateDirectories:YES attributes:nil error:nil];
    NSData *data = [NSJSONSerialization dataWithJSONObject:records options:0 error:nil];
    [data writeToFile:self.metadataPath atomically:YES];
  }
}

- (NSDictionary *)findRecord:(NSString *)modelId {
  for (NSDictionary *record in [self readMetadata]) {
    if ([record[@"id"] isEqualToString:modelId]) {
      return record;
    }
  }
  return nil;
}

- (void)upsertRecord:(NSDictionary *)record {
  NSMutableArray *next = [NSMutableArray new];
  for (NSDictionary *existing in [self readMetadata]) {
    if (![existing[@"id"] isEqualToString:record[@"id"]]) {
      [next addObject:existing];
    }
  }
  [next addObject:record];
  [self writeMetadata:next];
}

- (NSString *)sanitize:(NSString *)value {
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"];
  NSMutableString *result = [NSMutableString new];
  for (NSUInteger i = 0; i < value.length; i++) {
    unichar ch = [value characterAtIndex:i];
    [result appendString:[allowed characterIsMember:ch] ? [NSString stringWithCharacters:&ch length:1] : @"_"];
  }
  return result;
}

- (int64_t)fileSize:(NSString *)path {
  NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
  return [attributes[NSFileSize] longLongValue];
}

- (NSNumber *)diskUsageAtPath:(NSString *)path {
  BOOL isDirectory = NO;
  if (![[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&isDirectory]) {
    return @0;
  }
  if (!isDirectory) {
    return @([self fileSize:path]);
  }
  unsigned long long total = 0;
  NSArray<NSString *> *children = [[NSFileManager defaultManager] subpathsAtPath:path];
  for (NSString *child in children) {
    total += [self fileSize:[path stringByAppendingPathComponent:child]];
  }
  return @(total);
}

- (NSString *)sha256:(NSString *)path {
  NSInputStream *stream = [NSInputStream inputStreamWithFileAtPath:path];
  [stream open];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  uint8_t buffer[1024 * 256];
  NSInteger read = 0;
  while ((read = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
    CC_SHA256_Update(&context, buffer, (CC_LONG)read);
  }
  [stream close];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  NSMutableString *result = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
    [result appendFormat:@"%02x", digest[i]];
  }
  return result;
}

@end
