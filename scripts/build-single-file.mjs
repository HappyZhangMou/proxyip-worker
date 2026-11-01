/**
 * 把 src/lib.js 内联进 src/index.js，生成单文件版 dist/_worker.js
 *
 * 单文件版的用途：粘贴到 Cloudflare Dashboard 在线编辑器。
 * 那个编辑器不接受 import 其它文件。
 *
 * 用法： node scripts/build-single-file.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const lib = readFileSync(resolve(root, 'src/lib.js'), 'utf8');
const index = readFileSync(resolve(root, 'src/index.js'), 'utf8');

// 1. 去掉 lib 里的 export 关键字
const libBody = lib.replace(/^export (const|function) /gm, '$1 ');

// 2. 只移除顶部的 import 语句块，保留其余注释与代码
const indexBody = index.replace(
  /import \{[\s\S]*?\} from '\.\/lib\.js';\r?\n/,
  '',
);

if (/^import /m.test(indexBody)) {
  console.error('构建失败：index.js 里仍有未处理的 import 语句');
  process.exit(1);
}

const header = `/**
 * 住宅 ProxyIP 订阅重写 Worker —— 单文件版
 *
 * 本文件由 scripts/build-single-file.mjs 自动生成，请勿手动编辑。
 * 源码见 src/index.js 与 src/lib.js。
 *
 * 用途：粘贴到 Cloudflare Dashboard 在线编辑器（该编辑器不支持 import 其它文件）。
 * 通过 wrangler 或 Git 集成部署时，入口是 src/index.js，不使用本文件。
 */

`;

const output = header + libBody.trim() + '\n\n' + indexBody.trim() + '\n';

mkdirSync(resolve(root, 'dist'), { recursive: true });
const outPath = resolve(root, 'dist/_worker.js');
writeFileSync(outPath, output, 'utf8');

console.log(`已生成 dist/_worker.js (${output.length} 字节)`);
