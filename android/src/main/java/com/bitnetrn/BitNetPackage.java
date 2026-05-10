package com.bitnetrn;

import com.facebook.react.TurboReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;

import java.util.HashMap;
import java.util.Map;

public class BitNetPackage extends TurboReactPackage {
  @Override
  public NativeModule getModule(String name, ReactApplicationContext reactContext) {
    if (BitNetModule.NAME.equals(name)) {
      return new BitNetModule(reactContext);
    }
    return null;
  }

  @Override
  public ReactModuleInfoProvider getReactModuleInfoProvider() {
    return () -> {
      Map<String, ReactModuleInfo> modules = new HashMap<>();
      modules.put(
        BitNetModule.NAME,
        new ReactModuleInfo(
          BitNetModule.NAME,
          BitNetModule.NAME,
          false,
          false,
          true,
          false,
          true
        )
      );
      return modules;
    };
  }
}
