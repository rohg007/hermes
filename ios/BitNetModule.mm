#import "BitNetModule.h"

#import <React/RCTUtils.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import "RNBitNetSpec.h"
#import <ReactCommon/RCTTurboModule.h>
#endif

#import "BitNetDownloadManager.h"

#include <chrono>
#include <string>

#include "bitnet_rn/errors.hpp"
#include "bitnet_rn/native_facade.hpp"

static const int kBitNetDefaultMaxTokens = 512;

@interface BitNet ()
#ifdef RCT_NEW_ARCH_ENABLED
<NativeBitNetSpec>
#endif
@property(nonatomic, strong) BitNetDownloadManager *downloads;
@property(nonatomic) dispatch_queue_t queue;
@end

@implementation BitNet

RCT_EXPORT_MODULE(BitNet)

- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.bitnetrn.native", DISPATCH_QUEUE_CONCURRENT);
    _downloads = [[BitNetDownloadManager alloc] init];
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (NSDictionary *)constantsToExport {
  return @{
    @"nativeVersion": @"0.1.0",
    @"maxConcurrencyPerModel": @1
  };
}

static NSDictionary *BitNetParseJSON(NSString *json) {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) {
    return @{};
  }
  id payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [payload isKindOfClass:[NSDictionary class]] ? payload : @{};
}

static NSString *BitNetString(NSDictionary *dict, NSString *key, NSString *fallback) {
  id value = dict[key];
  return [value isKindOfClass:[NSString class]] ? value : fallback;
}

static int BitNetInt(NSDictionary *dict, NSString *key, int fallback) {
  id value = dict[key];
  return [value respondsToSelector:@selector(intValue)] ? [value intValue] : fallback;
}

static double BitNetDouble(NSDictionary *dict, NSString *key, double fallback) {
  id value = dict[key];
  return [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : fallback;
}

static bool BitNetBool(NSDictionary *dict, NSString *key, bool fallback) {
  id value = dict[key];
  return [value respondsToSelector:@selector(boolValue)] ? [value boolValue] : fallback;
}

static void BitNetReject(RCTPromiseRejectBlock reject, const bitnetrn::BitNetException &error) {
  NSString *code = [NSString stringWithUTF8String:bitnetrn::errorCodeName(error.code())];
  NSString *message = [NSString stringWithUTF8String:error.what()];
  reject(code, message, nil);
}

static void BitNetRejectStd(RCTPromiseRejectBlock reject, const std::exception &error) {
  reject(@"BITNET_NATIVE", [NSString stringWithUTF8String:error.what()], nil);
}

- (void)runAsync:(dispatch_block_t)block {
  dispatch_async(self.queue, block);
}

RCT_REMAP_METHOD(getRuntimeCapabilities,
                 getRuntimeCapabilitiesWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self runAsync:^{
    try {
      resolve([NSString stringWithUTF8String:bitnetrn::runtimeCapabilitiesToJson(bitnetrn::NativeFacade::shared().capabilities()).c_str()]);
    } catch (const bitnetrn::BitNetException &error) {
      BitNetReject(reject, error);
    } catch (const std::exception &error) {
      BitNetRejectStd(reject, error);
    }
  }];
}

RCT_REMAP_METHOD(loadModel,
                 loadModel:(NSString *)modelPath
                 optionsJson:(NSString *)optionsJson
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self runAsync:^{
    NSDictionary *options = BitNetParseJSON(optionsJson);
    try {
      bitnetrn::ModelLoadOptions loadOptions;
      loadOptions.id = std::string([BitNetString(options, @"id", modelPath) UTF8String]);
      loadOptions.runtime = bitnetrn::runtimeKindFromString(std::string([BitNetString(options, @"runtime", @"cpu") UTF8String]));
      loadOptions.contextSize = BitNetInt(options, @"contextSize", 2048);
      loadOptions.threads = BitNetInt(options, @"threads", 0);
      loadOptions.keepInMemory = [options[@"keepInMemory"] respondsToSelector:@selector(boolValue)] ? [options[@"keepInMemory"] boolValue] : YES;

      auto result = bitnetrn::NativeFacade::shared().loadModel(std::string([modelPath UTF8String]), loadOptions);
      resolve([NSString stringWithUTF8String:bitnetrn::loadModelResultToJson(result).c_str()]);
    } catch (const bitnetrn::BitNetException &error) {
      BitNetReject(reject, error);
    } catch (const std::exception &error) {
      BitNetRejectStd(reject, error);
    }
  }];
}

RCT_REMAP_METHOD(unloadModel,
                 unloadModel:(NSString *)modelHandle
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self runAsync:^{
    try {
      bitnetrn::NativeFacade::shared().unloadModel(std::string([modelHandle UTF8String]));
      resolve(nil);
    } catch (const bitnetrn::BitNetException &error) {
      BitNetReject(reject, error);
    } catch (const std::exception &error) {
      BitNetRejectStd(reject, error);
    }
  }];
}

RCT_REMAP_METHOD(startGeneration,
                 startGeneration:(NSString *)modelHandle
                 paramsJson:(NSString *)paramsJson
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self runAsync:^{
    NSDictionary *params = BitNetParseJSON(paramsJson);
    try {
      bitnetrn::GenerationParams generationParams;
      generationParams.prompt = std::string([BitNetString(params, @"prompt", @"") UTF8String]);
      generationParams.systemPrompt = std::string([BitNetString(params, @"systemPrompt", @"") UTF8String]);
      generationParams.chatTemplate = std::string([BitNetString(params, @"chatTemplate", @"") UTF8String]);
      generationParams.temperature = BitNetDouble(params, @"temperature", 0.8);
      generationParams.topK = BitNetInt(params, @"topK", 40);
      generationParams.topP = BitNetDouble(params, @"topP", 0.95);
      generationParams.maxTokens = BitNetInt(params, @"maxTokens", kBitNetDefaultMaxTokens);
      generationParams.seed = BitNetInt(params, @"seed", -1);
      generationParams.repeatPenalty = BitNetDouble(params, @"repeatPenalty", 1.1);
      generationParams.useChatTemplate = BitNetBool(params, @"useChatTemplate", false);

      std::string handle = bitnetrn::NativeFacade::shared().startGeneration(std::string([modelHandle UTF8String]), generationParams);
      resolve([NSString stringWithUTF8String:handle.c_str()]);
    } catch (const bitnetrn::BitNetException &error) {
      BitNetReject(reject, error);
    } catch (const std::exception &error) {
      BitNetRejectStd(reject, error);
    }
  }];
}

RCT_REMAP_METHOD(nextTokenBatch,
                 nextTokenBatch:(NSString *)generationHandle
                 maxTokens:(double)maxTokens
                 timeoutMs:(double)timeoutMs
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self runAsync:^{
    try {
      auto events = bitnetrn::NativeFacade::shared().nextTokenBatch(
        std::string([generationHandle UTF8String]),
        static_cast<std::size_t>(maxTokens),
        std::chrono::milliseconds(static_cast<int>(timeoutMs))
      );
      resolve([NSString stringWithUTF8String:bitnetrn::nativeEventsToJson(events).c_str()]);
    } catch (const bitnetrn::BitNetException &error) {
      BitNetReject(reject, error);
    } catch (const std::exception &error) {
      BitNetRejectStd(reject, error);
    }
  }];
}

RCT_REMAP_METHOD(cancelGeneration,
                 cancelGeneration:(NSString *)generationHandle
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self runAsync:^{
    try {
      bitnetrn::NativeFacade::shared().cancelGeneration(std::string([generationHandle UTF8String]));
      resolve(nil);
    } catch (const bitnetrn::BitNetException &error) {
      BitNetReject(reject, error);
    } catch (const std::exception &error) {
      BitNetRejectStd(reject, error);
    }
  }];
}

RCT_REMAP_METHOD(downloadModel,
                 downloadModel:(NSString *)requestJson
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self.downloads start:requestJson resolve:resolve reject:reject];
}

RCT_REMAP_METHOD(getDownloadProgress,
                 getDownloadProgress:(NSString *)jobHandle
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self.downloads progress:jobHandle resolve:resolve reject:reject];
}

RCT_REMAP_METHOD(awaitDownload,
                 awaitDownload:(NSString *)jobHandle
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self.downloads await:jobHandle resolve:resolve reject:reject];
}

RCT_REMAP_METHOD(cancelDownload,
                 cancelDownload:(NSString *)jobHandle
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self.downloads cancel:jobHandle resolve:resolve reject:reject];
}

RCT_REMAP_METHOD(listModels,
                 listModelsWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self.downloads list:resolve reject:reject];
}

RCT_REMAP_METHOD(deleteModel,
                 deleteModel:(NSString *)modelId
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self.downloads deleteModel:modelId resolve:resolve reject:reject];
}

RCT_REMAP_METHOD(getDiskUsage,
                 getDiskUsageWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self.downloads diskUsage:resolve reject:reject];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBitNetSpecJSI>(params);
}
#endif

@end
