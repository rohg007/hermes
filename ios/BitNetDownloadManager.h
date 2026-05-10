#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface BitNetDownloadManager : NSObject <NSURLSessionDataDelegate>

- (void)start:(NSString *)requestJson resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)progress:(NSString *)jobId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)await:(NSString *)jobId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)cancel:(NSString *)jobId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)list:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)deleteModel:(NSString *)modelId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)diskUsage:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;

@end
