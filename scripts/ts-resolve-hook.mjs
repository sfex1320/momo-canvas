// node --experimental-strip-types 的相对导入补全 hook：
// 源码内相对 import 不带扩展名（bundler 解析），node ESM 直跑时补 .ts / /index.ts
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    try {
      return await next(specifier, context);
    } catch (err) {
      for (const suffix of [".ts", "/index.ts", ".tsx", ".json"]) {
        try {
          return await next(specifier + suffix, context);
        } catch {
          /* 试下一个后缀 */
        }
      }
      throw err;
    }
  }
  return next(specifier, context);
}
