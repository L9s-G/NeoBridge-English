# AGENTS.md — 后续 Agent 作业手册（SOP）

> 给在本仓库工作的 AI agent / 新人：改代码前先读完「纪律」和「兼容红线」两节。
> 项目背景、数据流、模块详解见 `README.md`（本文件只讲"怎么干活不出事"。

## 这是什么

NeoBridge English：EVP 官方词库 → 纯静态 PWA（间隔答题 + 发音），**零构建、产物入库、
push 即部署**（Cloudflare Workers Static Assets，Root directory = `app/`）。
单站点双入口（站内叫法）：**潮流版** `app/index.html`（PWA，注册 SW）+ **经典版** `app/legacy.html`（iOS 12 等旧浏览器）。

## 常用命令

```bash
npm install                      # 首次
npm start                        # 静态服务 http://localhost:1080（SMOKE/手测都先起这个）
npm test                         # node --test，72 项 —— 任何改动后必跑
npm run build:legacy             # 重新生成 app/legacy.{html,js}（必跑条件见纪律 1）
npm run smoke                    # Playwright 冒烟新版入口（需本机 Chrome）
SMOKE_PATH=legacy.html npm run smoke   # 冒烟旧版入口
# 数据流水线（一般不用动）：npm run scrape / scrape:audio / audio / rebuild / build:pack
```

## 纪律（违反 = 测试红，或线上白屏）

1. **改了 `app/js/**` 或 `app/index.html` → 必须 `npm run build:legacy`**。
   `tests/legacy.test.js` 会现场重新构建并与入库产物比对，忘了跑直接测试失败。
2. **发版必须 bump `app/sw.js` 里的 `SHELL_CACHE` 版本号**（v15 → v16…），
   否则老用户外壳不刷新，改动静默不生效。
3. **`app/sw.js` 的 `SHELL` 预缓存清单要盖住所有入口用到的模块**：
   新增 `app/js/core/*.js` 这类被 import 的文件时，记得同步加进去（如 `./js/core/sha256.js`）。
4. **`app/legacy.html`、`app/legacy.js` 是构建输出，勿手改**；它们入库提交，
   Cloudflare 不跑构建 —— 源码改完必须本地构建再一起 commit。
5. **双入口语义别破坏**：`app.js` 里 `IS_LEGACY = !document.querySelector('link[rel="manifest"]')`。
   legacy.html 不带 manifest ⇒ 不注册 SW、隐藏「下载全部发音」卡（发音只在线播）。
   不要给 legacy.html 加 manifest，也不要让它注册 SW；标题栏的双入口互跳图标（`.classic-link`）别删
   （新版指向 legacy.html，`build:legacy` 会把旧版页面里的 href 改写为指回 index.html）。
6. **发音缓存名两处手工同步**：`app/js/ui/audio-download.js` 的 `AUDIO_CACHE` 与
   `app/sw.js` 的 `AUDIO_CACHE`（sw.js 是经典脚本不能 import，只能人肉一致）。
7. **动文件前先重读 / `git diff`**：本仓库常有人工并发编辑（品牌名、缓存前缀之类），
   别基于过期的文件内容做编辑。

## iOS 12 / Safari 12 兼容红线

esbuild 只降级**语法**，不补 API、不改 CSS。分两层管：

- **语法**（`?.` `??` 等）→ 由 `build:legacy` 机械降级，源码照常写现代语法。
- **运行时 API / CSS** → 回退必须写进共享源码或样式，新旧浏览器共用。四个先例：
  | 能力 | 回退位置 |
  |---|---|
  | `Element.replaceChildren`（14+） | `views.js` 导出 `replaceChildren()`，4 处调用点都走它 |
  | `navigator.clipboard`（13.1+） | `lists.js` `copyText()` 里 textarea + `execCommand('copy')` |
  | `crypto.subtle`（非安全上下文无） | `importer.js` `sha256Hex()` 回落 `core/sha256.js` 纯 JS（有对拍单测） |
  | `globalThis`（12.1+） | `audio-download.js` 用 `typeof caches === 'undefined'` 判定 |

**禁用**（esbuild 不救，源码出现即旧机炸/静默坏）：
`.replaceChildren(`、`globalThis`、`navigator.clipboard`、`String.replaceAll`、`Array.at`、
`Object.hasOwn`、`matchAll`、lookbehind / 命名捕获组 / `\p{…}` 正则、BigInt 字面量。
Safari 12 可用 ✓：`flat/flatMap`、解构、对象展开、`padStart`、`Object.entries`。

**CSS**：`clamp()`（13.1+）、flex `gap`（14.1+）、`:focus-visible`（15.4+）都要兜底，
套路照抄 `app.css` 对应注释（clamp → 前面放一行静态 `font-size`；focus-visible → 拆成两条规则；
flex gap → 文件末尾 `@supports` 块）。**flex gap 的检测不能用 `gap` 特性查询** ——
iOS 12 的 grid 已支持 gap，`@supports (gap)` 会误判；要用
`@supports (-webkit-touch-callout: none) and (not (translate: none))`（精准命中 Safari <14.1 且仅 WebKit）。

**esbuild 配置**（`scripts/build-legacy.mjs` 的 `BUILD_OPTIONS`）：
`target: 'safari12'` 必须配 `supported: { destructuring: true }` ——
esbuild 的保守数据会认为 Safari 12 不支持解构、直接报错，实际 Safari 10+ 就支持。

## 发版 SOP（按序执行）

1. 改代码 → `npm test` 绿（72 项）
2. 动过 `app/js` / `index.html` → `npm run build:legacy`
3. bump `SHELL_CACHE` 版本号（改 `app/sw.js`）
4. `npm start` 起服务 → `npm run smoke` 与 `SMOKE_PATH=legacy.html npm run smoke` 双双 `errors: none`
5. `git add`（**包含产物 `app/legacy.*`**）→ commit → push（push 即自动部署到 Cloudflare）
6. 回归：真机 iOS 12 人工过一遍旧版入口（CI 模拟不了 Safari 12；
   残余风险是 iOS 12 的 IndexedDB 怪癖 —— 白屏先查 console SyntaxError 再查 IDB）

## 关键文件速查

| 文件 | 干什么 |
|---|---|
| `scripts/build-legacy.mjs` | 旧版入口构建（BUILD_OPTIONS / 派生 legacy.html / 产物入库） |
| `app/js/app.js` | `IS_LEGACY` 信号、SW 注册 gate、启动流程 |
| `app/sw.js` | `SHELL_CACHE` 版本号、SHELL 预缓存清单、`AUDIO_CACHE` |
| `tests/legacy.test.js` | 产物防漂移 + 旧语法扫描 + legacy.html 派生一致性 |
| `tests/sha256.test.js` | 纯 JS SHA-256 对拍（NIST 向量 + crypto.subtle） |
| `scripts/smoke.mjs` | 双入口冒烟（`SMOKE_PATH` 选入口，断言 sw 注册数 / 发音卡可见性） |
| `app/app.css` 文件末尾 | iOS 12 flex gap 兜底块（新增带 gap 的选择器要同步补 margin） |
| `README.md` | 项目背景、数据流水线、旧版入口原理详解 |
