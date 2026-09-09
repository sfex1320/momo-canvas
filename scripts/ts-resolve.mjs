// 测试入口加载器：node --import ./scripts/ts-resolve.mjs --experimental-strip-types <test.ts>
import { register } from "node:module";
register(new URL("./ts-resolve-hook.mjs", import.meta.url));
