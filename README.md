# NeoBridge English（EVP B1/B2 离线背词 PWA）

从 [English Vocabulary Profile Online](https://englishprofile.org/?menu=evp-online) 抓取 CEFR **B1 + B2** 等级的
7101 条词条，落盘为本地 SQLite，再打成纯前端 PWA 的离线词包，
配合可调参数的自适应调度引擎反复复习。

三层结构，零构建：`scripts/` 数据管线 → `app/` 静态 PWA → IndexedDB 用户数据。

## 目录结构

```
.
├── scripts/
│   ├── scrape-evp.mjs        抓取脚本（Playwright 驱动系统 Chrome + 拦截响应）
│   ├── scrape-audio-urls.mjs 抓官网音频表 → data/raw/audio-files.json（含加密请求复刻）
│   ├── download-audio.mjs    把发音 mp3 下载到 app/audio/（断点续传）
│   ├── rebuild-db.mjs        从 checkpoint 重建 DB（不联网）+ 19 项校验
│   ├── build-dataset.mjs     SQLite → DLC 词包 + 25 项校验
│   ├── evp-lib.mjs           共享：字段映射、entry 归一化、SQLite 写入
│   ├── audio-lib.mjs         共享：音频表翻页、名称归一、并发下载
│   ├── report-evp.mjs        词库查询 / 抽查工具
│   ├── build-legacy.mjs      生成旧版入口 legacy.html + legacy.js（esbuild safari12）
│   ├── smoke.mjs             Playwright 冒烟（SMOKE_PATH=legacy.html 跑旧版入口）
│   └── serve.mjs             零依赖静态服务器（npm start）
├── data/                   ① 源库（开发机，只读，永不发布）
│   ├── evp.sqlite
│   └── raw/
│       ├── checkpoint.json   抓取断点（7101 条原始记录，可用于重建 DB）
│       └── audio-files.json  官网音频表（13229 行，name → mp3 URL）
├── app/                    ② PWA 根目录，纯静态、零构建（+ 双入口：新版 PWA / 旧版 legacy）
│   ├── index.html          外壳（新版入口，带 manifest → 注册 SW）
│   ├── legacy.html         旧版入口（`npm run build:legacy` 生成，无 manifest → 不注册 SW）
│   ├── legacy.js           旧版入口的打包产物（esbuild target=safari12，勿手改）
│   ├── app.css / icon.svg / manifest.webmanifest
│   ├── sw.js               Service Worker：外壳缓存 + 词包缓存 + 发音缓存
│   ├── wrangler.jsonc      Cloudflare Workers 部署配置（Root directory = app）
│   ├── _headers / .assetsignore  部署缓存头规则 / 上传排除清单
│   ├── audio/              官网发音 mp3（3701 个，约 23 MB，`npm run audio` 下载）
│   ├── js/
│   │   ├── app.js          启动流程：开库 → 恢复词包 → 下载 → 渲染
│   │   ├── core/           ③ 调度引擎（纯函数，无 IO，Node 可直接单测）
│   │   │   ├── params.js       ★ 全部可调参数，调参只改这一个文件
│   │   │   ├── mastery.js      作答信号 → 掌握度增量
│   │   │   ├── weight.js       词层权重：等级 × 掌握度 × 池内新鲜度
│   │   │   ├── pools.js        三池划分 + coverage 配额
│   │   │   ├── progress.js     进度状态的创建与更新
│   │   │   ├── scheduler.js    抽一个词：去重 → 分池 → 配额 → 加权随机
│   │   │   ├── queue.js        抽一整轮：预抽题队列（session 内不重复）
│   │   │   ├── day.js          日历工具：dayKey / lastDays / relDay（7 天卡片）
│   │   │   └── sha256.js       纯 JS SHA-256（crypto.subtle 不可用时的校验兜底）
│   │   ├── ui/             答题界面
│   │   │   ├── session.js      状态与流程：作答 → 落库 → 重画
│   │   │   ├── views.js        只把状态画成 DOM，无状态判断（replaceChildren 兼容实现 + fitWord 宽度自适应）
│   │   │   ├── audio-download.js 发音：缓存下载、进度、正面 🔊 播放
│   │   │   └── lists.js        首页清单：7 天卡片 + 错词名单（一键复练）+ 一键复制
│   │   └── db/             本地存储与 DLC 管理
│   │       ├── idb.js          IndexedDB 的 Promise 封装
│   │       ├── stores.js       库结构 + 读写接口
│   │       └── importer.js     下载 / 校验 / 启动自愈 / 删除
│   └── data/
│       ├── manifest.json   DLC 包描述（sha256 / 字数 / 版本）
│       └── words.v2.json   ★ DLC 词包正文
├── tests/                  npm test（node --test，72 项）
│   ├── _rng.js             固定种子随机数
│   ├── scheduler.test.js   调度引擎 + 错词恢复规则单测
│   ├── queue.test.js       题队列单测
│   ├── day.test.js         日历工具单测（跨月 / 跨年 / 闰年）
│   ├── simulation.test.js  真实 5008 词 × 8000 次抽样的模拟
│   ├── importer.test.js    词包校验单测（直接跑真实 app/data/）
│   ├── audio.test.js       发音覆盖单测（词包 ↔ app/audio/ 一一对应）
│   ├── sha256.test.js      纯 JS SHA-256 对拍 crypto.subtle + NIST 向量
│   └── legacy.test.js      旧版入口：构建成功 + 产物无旧语法 + 防漂移
├── package.json
├── AGENTS.md               后续 Agent 作业手册（发版 SOP + iOS 12 兼容红线）
└── README.md
```

三层数据，单向流动，互不越界：

| 层 | 位置 | 性质 | 变更方式 |
|---|---|---|---|
| ① 源库 | `data/evp.sqlite` | 官方数据，开发机 | 重抓 → `npm run rebuild` |
| ② DLC 词包 | `app/data/*.json` | 官方数据，只读，整包替换 | `npm run build:pack`；发 C2 = 新增一个包 |
| ②b 发音 | `app/audio/*.mp3` | 官方音频，只读 | `npm run scrape:audio` + `npm run audio` |
| ③ 运行时库 | IndexedDB | 用户进度 / 每日答题记录 / 题目 / LLM 缓存 | 只增不改，随卸载消失，永不随换包清除 |

## 快速开始

环境要求：**Node.js ≥ 22**（用到内置 `node:sqlite`）、本机已装 **Chrome** 或 **Edge**。

```bash
npm install                # 安装 playwright-core
npm run scrape             # 全量抓取（约 3.5 分钟）
npm run scrape:fresh       # 忽略断点，从头抓
node scripts/scrape-evp.mjs --max-pages 5   # 冒烟测试（5 页）
npm run scrape:audio       # 抓官网音频表（34 页 / 约 18 秒）→ data/raw/audio-files.json
npm run audio              # 下载发音 mp3 → app/audio/（3701 个 / 23 MB，可续传）
npm run rebuild            # 不联网，从 checkpoint 重建 DB 并跑校验
npm run build:pack         # 打 DLC 词包 → app/data/（含 25 项校验）
npm run report             # 查看总量与等级分布
npm start                  # http://localhost:1080，同时监听 0.0.0.0（局域网可访问）
npm run build:legacy       # 重新生成 app/legacy.{html,js}（改了 app/js 之后必须跑）
npm test                   # 72 项：调度引擎 + 题队列 + 日历 + 词包 + 发音 + SHA256 + legacy 产物 + 全量模拟
SMOKE_PATH=legacy.html npm run smoke   # 冒烟跑旧版入口（默认跑 /）
node scripts/report-evp.mjs --level B1 --search abandon
node scripts/report-evp.mjs --entry account  # 按词头查整个词条族
node scripts/report-evp.mjs --entry ID_00003010
```

## 词库结构

```sql
CREATE TABLE evp_word (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bubble_id     TEXT    NOT NULL UNIQUE,  -- 源站记录 _id
  base_word     TEXT    NOT NULL,         -- Base Word
  guideword     TEXT,                     -- 义项指引，如 abandon / LEAVE
  level         TEXT    NOT NULL,         -- B1 | B2
  pos           TEXT,                     -- Part of Speech
  topic         TEXT,                     -- Topic（源数据 63.7% 有值）
  headword      TEXT    NOT NULL,         -- 词头 hw_text，词条归档形式
  refid         TEXT,                     -- 源站 refid（可能是义项级）
  entry_refid   TEXT    NOT NULL,         -- 归一化到词条级，用于 join evp_entry
  details_url   TEXT,                     -- 精确到 refid 的详情链接
  entry_url     TEXT,                     -- 词条级详情链接（整个词条族）
  definition    TEXT,                     -- 英文释义
  pronunciation TEXT,                     -- 音标（英式）
  examples      TEXT,                     -- 学习者例句（多句以 " ; " 分隔）
  audio_name    TEXT                      -- 发音文件名（小写规范名，见下）
                                        -- 非空 ⇔ evp_audio 里查得到 URL ⇔ 有本地 mp3；
                                        -- 官网自己缺失的 5 个名（7 行）按 NULL 存
);

CREATE TABLE evp_entry (                  -- 词典词条（family）
  refid        TEXT PRIMARY KEY,          -- == evp_word.entry_refid
  headword     TEXT    NOT NULL,
  member_count INTEGER NOT NULL,          -- 该词条下 distinct base_word 数
  sense_count  INTEGER NOT NULL,          -- evp_word 行数
  levels       TEXT    NOT NULL,          -- 'B1,B2'
  member_words TEXT    NOT NULL           -- 成员列表，\n 分隔
);

CREATE TABLE evp_audio (                  -- 官网音频表：文件名 → mp3 URL
  name TEXT PRIMARY KEY,                  -- 已归一为小写
  url  TEXT    NOT NULL
);
```

### refid 的语义：refid = 一个词典词条，不是"同义词组"

源数据的规律是**双向多对多**，但成因不同：

| 关系 | 数量 | 成因 |
|---|---|---|
| 1 个 refid → 多个 base_word | 591 / 3862 | 同一词头下的**词义 + 派生短语** |
| 1 个 base_word → 多个 refid | 244 / 5008 | **交叉挂载**：短语被挂在它包含的每个词下 |

- **一个 `refid` ↔ 一个 `headword`**（3859 个词头，0 例外）。`evp_entry` 就是这个分组。
- `ID_00000045`（headword `account`）= 2 个词义 + `on account of` / `take account of` /
  `take into account` → 4 个成员、5 行。
- `all over again` 同时属于 `again` / `all` / `over` 三个词条；`as a matter of fact` 属于
  `as` / `fact` / `matter` —— 站点的交叉索引，不是脏数据。
- `tear` / `row` / `lie` 是真·同形异义词，各自独立 refid（这也是
  distinct `entry_refid` = 3862 > distinct `headword` = 3859 的原因）。

因此**打开一个 refid 会看到整个词条族**（你观察到的现象）：

```bash
node scripts/report-evp.mjs --entry ID_00003010   # headword "in"，49 个成员
```

**3 行特例**：`in` 的 3 个 adverb 义项，源数据 `refid` 直接给的是义项级 ID
（`ID_00003010_520_UK`）。已验证这种链接在站点上**能正常打开，且只显示那一个义项**——
所以 `refid` / `details_url` 原样保留（更精确），另用 `entry_refid` / `entry_url`
归一化到词条级，保证 7101 行全部能 join `evp_entry`。

> 注意：**详情页不受 B1/B2 筛选约束**。列表只抓 B1+B2，但 `ID_00003010` 的词条页
> 会连 A1/A2 义项一起显示（如 `in (INSIDE) A1`）。app 若要严格限定 B1+B2，
> 以 `evp_word` 为准，别直接渲染词条页。

## 数据校验（2026-09-28）

`npm run rebuild` 内置 19 项断言，全部通过：

| 指标 | 结果 |
|---|---|
| 总条数 | **7101**（预期 7101） |
| 等级分布 | B1 = 2937，B2 = 4164 |
| distinct base_word | 5008 |
| distinct headword | 3859 |
| distinct refid（源站原值） | 3865 |
| distinct entry_refid（归一化） | **3862** = 3859 词头 + tear/row/lie 3 个词条 |
| evp_entry 行数 | 3862，其中 multi-member **591** |
| refid ≠ entry_refid 的行 | 3（全部为 `in` 的义项级 refid） |
| headword / details_url / definition / pos 填充率 | 100% |
| 孤儿 entry_refid / 词条词头不一致 | 0 / 0 |
| examples / pronunciation / topic / guideword | 99.9% / 76.9% / 63.7% / 48.2% |
| `audio_name` 填充 | **5455 行 / 3701 个文件名**（与词包 `a` 完全一致） |
| `evp_audio` 行数 | 13229（官网 13227 + 详情页兜底 2） |
| `audio_name` 有名字但查不到 URL | **0 行**（写库时按 NULL 处理） |
| 官网声称有、音频表却没有的文件名 | 5 个 / 7 行（从 checkpoint 记账，异常仍看得见） |

B1/B2 计数与 2022 年公开抓取结果（Granitosaurus/englishprofile-scraper）完全一致。
guideword、topic 填充率偏低是源数据本身如此——只有多义词/有主题分类的词才有值。

词条数 7101 ≠ 单词数：同一 base word 可因义项指引、词性不同拆成多行
（如 `although / BUT`、`although / DESPITE` 各算一条），全部保留未去重。

## DLC 词包（`app/data/`）

`npm run build:pack` 从源库导出，**所有加工都在构建期完成，运行时零成本**。

```jsonc
// words.v2.json
{
  "schemaVersion": 1, "packId": "evp-uk-b1b2", "version": 2,
  "levels": ["B1","B2"], "wordCount": 5008, "senseCount": 7101,
  "baseUrl": "https://englishprofile.org/?menu=evp-online&refid=",  // 链接前缀，见下
  "words": [{
    "k": "account",            // wordKey = base_word.trim().toLowerCase()，进度主键
    "w": "account",            // 展示用原词形
    "levels": ["B1","B2"],     // 跨级不丢信息；权重取最高等级
    "entries": ["ID_00000045"],// 该短语中每个需要解释的词（词条 id）
    "zh": null,                // 中文释义，S1.5 回填
    "senses": [{
      "hw": "account",         // 词头（同一词的不同义项可归属不同词族）
      "guide": "BANK",         // 义项指引
      "level": "B1", "pos": "noun", "topic": "money",
      "def": "an arrangement with a bank ...",
      "ipa": "əˈkaʊnt",
      "ex": ["I've opened an account with another bank.", "..."],  // 已清洗、已拆句
      "a": "epd32426",         // 发音文件名 → app/audio/epd32426.mp3；null = 官网没有
      "refid": "ID_00000045"   // 只存站点标识
    }]
  }]
}
```

**v1 → v2 只多了一个义项字段 `a`**（发音文件名）。7101 个义项里 **5455 个有发音**
（3701 个去重文件，23 MB），其余 1646 个义项官网就没给音频，`a` 为 `null`，
前端回落 YouGlish 外链。`schemaVersion` 仍是 1：`a` 是可选字段，
新旧包互读都不炸（老包没这个字段 = 没有本地发音）。

**包里只存标识，不存派生 URL**：与源库 `scripts/evp-lib.mjs` 的做法一致，
链接在运行时拼，省掉 7101 次重复的 50 字节前缀（词包 3.44 MB → 3.10 MB）：
发音则是反过来——**存文件名不存 URL**，URL 每个文件唯一、拼不出来，
`app/audio/` 里按 `<a>.mp3` 落盘，同源请求由 Service Worker 直接回缓存。

```
义项详情页  = payload.baseUrl + sense.refid
词条族页面  = payload.baseUrl + word.entries[i]
```

`baseUrl` 放在词包头部而不是 `manifest.json`，是为了让 `words.v2.json`
**自解释**——它本来就带着 `packId`/`version`/`levels` 等全部包属性；
`manifest.json` 保持只做下载描述符（`file`/`bytes`/`sha256`），两者不重叠。

**为什么聚合到 5008 而不是 7101**：调度以"词"为单位（同词不同义项连续抽中体验差），
义项在 `senses` 里聚合展示。`manifest.json` 带 `sha256`/`bytes`/`wordCount`，
是 DLC 换包时的校验依据。

**进度主键用 `k` 而非行号**：日后发 C2 包，B1/B2 的进度自动继承，新词天然是"未见过"。

### 例句清洗

例句里的方括号是 Cambridge 编辑对学习者原文错误的修正标记：

> "Any errors made by the writer that are **peripheral to the use of the target word or
> phrase are corrected within square brackets**."
> —— Capel (2010), *A1–B2 vocabulary*, English Profile Journal

官网 UI 原样保留括号（教学提示），但词包里**删括号、保留内容**即得修正后的正确句子：

```
raw   : On Wedn[e]sday morning ... to see [the]Vatican.
clean : On Wednesday morning ... to see the Vatican.
```

涉及 2489/7101 行（35%）、3551 处标记。唯一需要补空格的情况是"修正内容以小写结尾、
紧随其后是大写字母"（全库仅 1 处，上面那句），规则已在 `cleanExamples()` 内处理。
校验项 `bracket residue in examples = 0` 保证不漏。

## 本地存储与词包管理（`app/js/db/`）

零依赖的浏览器端三层：`idb.js` 是 IndexedDB 的 Promise 封装，
`stores.js` 定义库结构与读写接口，`importer.js` 管下载 / 校验 / 自愈 / 删除。

### 五个对象仓库（`DB_VERSION = 2`）

| store | 主键 | 内容 |
|---|---|---|
| `meta` | `key` | `active_pack` —— 当前激活的词包 id |
| `pack` | `id`（= `packId@version`） | 已下载词包，**多包共存** |
| `progress` | `k`（wordKey） | 掌握度 / 作答次数 / 错词状态 / 最近结果，**永不随删包清除** |
| `daily` | `<day>\|<k>` | 每天每词一条记录（`wrong` 只会从 false 变 true），驱动首页 7 天卡片 |
| `question` | `id` | 题库（S6 填充） |

`progress` 上预建 `byLastAnswerAt` / `byLastResult`，`daily` 上建 `byDay` 索引。

**v1 → v2 升级**：`upgrade()` 给每个 store 都加了「已存在就跳过」的判断，
旧库打开时只补建 `daily`，`progress` / `pack` / `meta` 原样保留——升级不丢进度。

### 下载校验：三层，任一不过就不落库

1. **字节数** = `manifest.bytes`
2. **sha256** = `manifest.sha256`
3. **包内自洽** `validatePack()`：`schemaVersion` / `baseUrl` / `wordCount` /
   `senseCount` / 每个词都有 `wordKey`

第 3 层不需要 manifest，所以启动自愈时也能用它。

### 更新模型：手动删除 → 重新下载

**不做自动更新检测。** 一个 `packId` 一个 key，多包共存、可各自下载 / 删除 / 切换；
同 `packId` 的旧版本在**显式重下**时由 `removeSuperseded` 让位，不会出现两条 B1B2。
用户点"删除"再点"下载"即完成同步 —— 交互与参考项目 Black2Lock-reborn 的 DLC 层一致。

`manifest.json` 保持只做下载描述符（`file`/`bytes`/`sha256`/`wordCount`），
`baseUrl` 放在词包头部，两者不重叠。

### 启动自愈

`restorePacks()` 每次启动逐个解码 + 结构校验，**坏包直接删掉**
（只删 `pack` 记录，绝不碰 `progress`），并把指向已消失包的 `active_pack` 指针收拾干净。

### PWA 离线

- `app/sw.js` 三个缓存：
  - `neobridge-shell-v<N>`（页面与代码，`N` 见 `sw.js` 的 `SHELL_CACHE`），install 时预缓存；
  - `neobridge-pack-<sha256>`（词包正文），install 时预缓存，并清掉别的词包缓存；
  - `neobridge-audio-v1`（发音 mp3，约 23 MB）——**不预缓存、不随发版删除**，
    由设置页「下载全部发音」逐个写入，SW 只负责把 `/audio/*` 的读写都路由到这里，
    这样换 `SHELL_CACHE` 版本号不会连坐清掉音频。
- **`/data/*.json` 走网络优先**（`handle()` → `networkFirst()`）：缓存里的旧
  `manifest.json` 会让人下到旧版词包，而旧词包没有 `a` 字段 → 整页卡片退回 YouGlish。
  在线以服务器为准，离线才回退缓存。
- **发新版必须改 `sw.js` 里的 `SHELL_CACHE` 版本号**，否则外壳不会刷新。
- `npm start` 起 `scripts/serve.mjs`：默认 **1080** 端口、绑 `0.0.0.0`
  （`PORT=` / `HOST=` 可覆盖），启动时会打印本机 IPv4，手机连同一 Wi-Fi 直接
  `http://<局域网IP>:1080/` 打开即可测试。
- **局域网 IP 不是安全上下文**：Service Worker 注册不了，`crypto.subtle`
  与 `caches`（发音缓存）也都不可用 —— 词包 sha 校验会自动回落纯 JS 实现
  （`core/sha256.js`），照常能下；要测 PWA 离线则手机 Chrome 先到
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 填 `http://<IP>:1080`
  并重启浏览器；另外 Windows 防火墙要放行 1080 入站（默认无 node 规则会被拦）。
- `file://` 打不开 —— Service Worker 与 `crypto.subtle` 都要求安全上下文，
  本地必须走 `http://localhost`（或加白名单的局域网 IP）。

### 旧版入口（iOS 12 / Safari 12）

iOS 12（Safari 12）上整页白屏的真凶是 **`?.` / `??` 语法**（Safari 13.1 才支持）——
模块解析阶段就 SyntaxError，与 PWA/SW 无关（iOS 11.3 起 SW 本身可用）。为此加了
`legacy.html` 双入口：源码保持现代写法，旧浏览器兼容由构建保证。

站内统一叫法：**潮流版** = `index.html`（默认 PWA 入口）、**经典版** = `legacy.html`；
标题栏右侧的「经典小电视」图标（`.classic-link`）双向互跳，**图标本身兼作模式提示**：
潮流版里默认灰、hover/focus 亮（提示"点我进经典版"）；经典版里默认亮、hover/focus 灰
（提示"点我回潮流版"）。`app.js` 按 `IS_LEGACY` 加 `.on` 决定默认色，`title` 启动时改成
「当前：潮流版 · 点按切换经典版 / 当前：经典版 · 点按切回潮流版」（HTML 里的静态
`title`/`aria-label` 仍是兜底文案）。

- **入口差异**：潮流版 `index.html` 带 manifest → 注册 SW；经典版 `legacy.html` 无
  manifest ⇒ `app.js` 的 `IS_LEGACY` 为真 ⇒ **不注册 SW、整块隐藏「下载全部发音」卡**
  （发音只在线播，卡片正面 🔊 直接指向同源 mp3）。小电视图标在经典版里由构建
  改写为指回潮流版（href + title + aria-label 一并改写）。
- **入口 URL 一律不带 `.html`**：经典版回潮流版的 href 是 `./`，`manifest` 的
  `start_url` 也是 `./`。原因在边缘 —— Cloudflare Workers Static Assets 的
  `html_handling` 默认 `auto-traffic`，会把 `/index.html` **307 重写**到 `/`、
  把 `/legacy.html` 307 到 `/legacy`（所以经典版的真实地址是 `/legacy`）。
  少一跳就少一个坑；`tests/legacy.test.js` 有断言盯着（`start_url` 与两个 href）。
  `tests/legacy.test.js` 有断言盯着（`start_url` 与两个入口的 href）。
- **SW 导航兜底 `asNavigation()`**：跳转本身不致命，致命的是被跳转**污染过的缓存**。
  导航请求的 redirect mode 是 `manual`，浏览器规定：响应只要带 `redirected` 标志就判成
  网络错误，整页白屏，console 报
  `The FetchEvent for "…" resulted in a network error response: a redirected response
  was used for a request whose redirect mode is not "follow"`。
  而 `installAll()` 里 `addAll(['./index.html'])` 跟过 307 之后，缓存里那条
  `/index.html` 就带着这个标志，之后每次导航命中它都白屏（`/index.html` 是重灾区；
  `/legacy.html` 没进预缓存清单，只是运行时才可能中招）。反过来，
  `fetch(request)` 拿到的 `opaqueredirect` 是**合法**的，浏览器会自己去跟跳转。
  所以 `handle()` 三个返回点（缓存命中 / 网络结果 / 离线兜底）都过一遍
  `asNavigation()`：导航请求 + `redirected` 响应就重建成干净的副本。
  以后换任何服务器（防火墙、网关、别的静态托管）来 3xx 都不会再白屏。
- **构建**：`npm run build:legacy` 用 esbuild 把 `js/app.js` 整棵模块图打成
  `legacy.js`（iife、`target=safari12`，`?.`/`??` 机械降级），`legacy.html` 由
  `index.html` 派生。**产物入库，Cloudflare 照旧零构建部署**；data/audio 不复制，
  双入口同源共享。
- **纪律**：改了 `app/js` 或 `index.html` 必须重跑 `build:legacy` ——
  `tests/legacy.test.js` 会重新构建与入库产物比对，忘了跑就测试红。
- **运行时 API 不归 esbuild 管**，回退写在共享源码里，新旧浏览器共用一份：

  | 位置 | Safari 12 缺什么 | 回退 |
  |---|---|---|
  | `views.replaceChildren()` | `Element.replaceChildren`（14+） | 等价实现，4 处调用点改走它 |
  | `lists.copyText()` | `navigator.clipboard`（13.1+） | textarea + `execCommand('copy')` |
  | `importer.sha256Hex()` | 非安全上下文没有 `crypto.subtle` | 纯 JS `core/sha256.js`（对拍单测） |
  | `audio.countCached()` | `globalThis`（12.1+） | `typeof caches` 判定 |

- **CSS 降级**（`app.css`，现代浏览器整块不生效）：`clamp()` 前置静态字号（13.1+）；
  flex `gap` 补 margin（14.1+）——注意 **不能** 用 `@supports not (gap)`，iOS 12 的
  grid 已支持 gap、feature query 会误判，实际用的是 `(-webkit-touch-callout) and
  (not (translate))` 检测（见 app.css 注释）；`:focus-visible` 拆成独立规则（15.4+，
  否则整条连 `:hover` 一起被丢）。
- **冒烟**：`SMOKE_PATH=legacy.html npm run smoke`（跑 `/` 为默认新版）。
  真机 iOS 12 需人工过一遍 —— CI 模拟不了 Safari 12，残余风险是它的 IndexedDB 怪癖。

### 部署到 Cloudflare（Git 连接 + 自动部署，手机测 HTTPS 最省事）

生产部署走 **Workers Static Assets**：Cloudflare 连 GitHub 仓库，`git push` 即自动上线，
访问地址 `https://neobridge.workers.dev`。

**Dashboard 一次性配置**（Workers & Pages → Create application → Connect Git）：

| 项 | 值 |
|---|---|
| Repository | `L9s-G/NeoBridge-English` |
| **Root directory** | `app` —— 只以 `app/` 为项目根，仓库其余部分（`scripts/` `tests/` `data/` `node_modules/`）不参与部署 |
| Build command | 留空（`app/` 已是构建产物，零构建） |
| Deploy command | `npx wrangler deploy`（默认） |
| Framework preset | None |

之后每次 `git push` 到 `main` 触发一次部署。

- **配置文件是 `app/wrangler.jsonc`**：assets-only Worker（不写 `main`），
  `assets.directory: "."` 相对该文件，即部署 `app/` 自身；`app/.assetsignore`
  把 `wrangler.jsonc` 排除在上传之外，不会被公开访问。
- **站点根是 `app/`**（页面里全是 `./` 相对路径，没有前缀问题）。
  全站 3700+ 个文件 / 约 26 MB（`audio/` 22.7 MB + `data/` 3.1 MB），
  远在 Workers 限制内（20,000 文件 / 单文件 25 MiB）。
- **增量上传**：wrangler 对 assets 目录逐文件算哈希生成 manifest，与上次部署 diff，
  只上传哈希变化与新增的文件、删除消失的文件。所以全量只发生在**首次**部署，
  日常 push 只改几个文件就只传几个文件，3700+ 文件也不会拖慢。
- **发版提醒**：外壳有更新时要 bump `sw.js` 的 `SHELL_CACHE` 版本号，
  否则旧 SW 不刷新（见上文「PWA 离线」）——这与 Cloudflare 无关，push 前记得改。
- `app/_headers` 同样被 Workers Static Assets 解析（不只 Pages）：`/data/*` 与 `/sw.js`
  强制 `no-cache`，免得浏览器 HTTP 缓存把旧 `manifest.json` 喂给「网络优先」的 SW（本地
  `scripts/serve.mjs` 自己发 no-cache，忽略这个文件）。
- 本地手动部署 / 预演（可选）：`npx wrangler login` 后在 `app/` 下
  `npx wrangler deploy`；`npx wrangler deploy --dry-run --outdir <目录>` 只列产物清单不上传。
- HTTPS 一到位全绿：SW / `crypto.subtle` / `caches` 都能用，手机不用加白名单。
- **部署 = 公网可见**（Cambridge 版权，见文末版权节，仅限个人使用）：
  要么给域名套一层 Cloudflare Access，要么改用 Tunnel 把本机 1080 挂出去：
  `cloudflared tunnel --url http://localhost:1080` → `https://<随机>.trycloudflare.com`，
  文件不上传、本机改完即生效。

## 调度引擎（`app/js/core/`）

决定"下一个出哪个词"。**纯函数、无 IO**，`words` / `states` / `coverage` /
`sessionSeen` / `rng` / `now` 全部由调用方注入，所以 `npm test` 能直接在
Node 里跑单测与全量模拟（全 72 项）。

### 抽一个词的四步

1. **session 去重** —— 本次 session 已出过的词直接排除，不设分钟级冷却；
   全部出完则返回 `null`
2. **分池** —— 按 `poolOf` 落进 `new` / `err` / `rev` 之一
3. **配额** —— 按 `coverage` 取三池份额，空池的份额按比例摊给别的池
4. **池内加权随机** —— 按 `wordWeight` 做轮盘赌

### 五个维度拆在三层

| 维度 | 归属 | 说明 |
|---|---|---|
| `level` | `weight.js` | 等级权重 |
| `mastery` | `weight.js` + `pools.js` | 前者决定权重，后者决定分池 |
| `timesSeen` | `weight.js` | 池内新鲜度，防止老词霸屏 |
| `coverage` | `pools.js` | **只进配额，不进权重公式** |
| session 去重 | `scheduler.js` | **只做过滤，不进权重公式** |

"最近答错"同样不进公式 —— 它通过 mastery 下降 + 进入错词池两条路生效，
错词出现的频率完全由配额控制，避免两套规则打架。

### 参数（全部集中在 `params.js`）

| 参数 | 默认值 | 含义 |
|---|---|---|
| `levelWeight` | B2 `1.4` / B1 `1.0` | 等级权重 |
| `masteryExponent` | `1.6` | `(1-mastery)^1.6`，越大则已掌握的词降得越快 |
| `freshnessDecay` | `0.1` | `1/(1+0.1×timesSeen)` |
| `errPoolThreshold` | `0.45` | mastery 低于此即进错词池 |
| `recoverStreak` | `2` | 错词「连对几次算恢复」，见下 |
| `quotas.start` | 75 / 10 / 15 % | coverage=0 时 new/err/rev |
| `quotas.end` | 30 / 40 / 30 % | coverage=1 时 new/err/rev |

配额随 coverage **线性插值**：新词过得越多，错词占比越大（10% → 40%）。
这就是"错误与新词的比例"的实现方式——用户问得越多，错词问得越狠，
新词始终保留三成。

### 作答信号 → 掌握度（`mastery.js`）

| 信号 | 含义 | mastery 变化 |
|---|---|---|
| `right` | 熟悉 | `m += (1-m) × 0.18` |
| `examRight` | 考试题型答对（主动回忆） | `m += (1-m) × 0.30` |
| `fuzzy` | 一般 | `m ×= 0.75` |
| `wrong` | 标记 / 答错 | `m ×= 0.45` |

掌握度之外还维护三组**只做分类、不进权重公式**的计数：

| 字段 | 何时变化 | 用途 |
|---|---|---|
| `wrongs` | 答错 +1，答对不清零 | 累计错次，> 0 才有资格算错词 |
| `lastWrongAt` | 每次答错刷新 | 错词名单按「最久没练的在前」排序 |
| `rightStreak` | 答对 +1；**答错或模糊都清零** | 连续正确次数，决定错词是否已恢复 |

`fuzzy` 对这组计数是**故意不对称**的：它会打断 `rightStreak`（模糊不算「连对 2 次」），
但不清零也不增加 `wrongs`（模糊不算错）。`wrongStreak` 保留原语义，只用于连续答错提示。

### 扩展点

换算法只动 `weight.js` / `mastery.js` / `pools.js` 之一，三者是签名固定的纯函数，
`scheduler.js` 的抽样流程不受影响；调参只改 `params.js`。

## 答题流程（`app/js/ui/`）

只有一条「抽卡复习」链路，节奏是**看词 → 回忆 → 点「开」对照 → 标一档 → 自动跳下一个**：

| 阶段 | 屏幕 | 按钮 → 信号 |
|---|---|---|
| 未翻面 | 只出词 + 音标 + 喇叭（有本地发音是播放按钮，没有则回落 YouGlish 链接），**不给任何释义** | 「开」→ 翻面 |
| 已翻面 | 正面 + 全部义项 + guide + 例句 | 熟悉 → `right`，一般 → `fuzzy`，标记 → `wrong` |

- 一轮固定题数（10 / 20 / 50，**唯一来源是 `index.html` 的 `#size` 下拉**，`app.js` 不再另写默认值），
  **标完一档直接进下一题**（`answer()` 落库后调 `next()`），
  中途没有"已记录 / 下一步"确认页，最后一题标完直接出小结
- 每答一题**先写 `progress` 再写 `daily`，两个都落库才翻页**，中途关页面也不会丢这一题
- 结束出小结：三档计数 + 标记的词清单，可**一键重练这些词**（队列只从这些词里抽）
- 进度区「强化记忆」名单另有**「复练全部」**：题数 = 名单长度，队列只从名单里抽，
  走同一条 `openSession({ words, size })` 路径（`app.js` 的 `startSession(size, words)` 接受任意词子集）
- 进度按 `wordKey` 落 `progress` 仓库，刷新、换包、删除重下都不会丢

### 发音（`ui/audio-download.js`）

词包里 **3705 / 5008 个词有官方发音**（5455 / 7101 个义项，去重 3701 个 mp3，约 23 MB），
其余 1303 个词官网没给音频 —— 这些卡的喇叭保持 YouGlish 外链。

**没音频的 1303 个几乎全是短语类**：

| 类别 | 条数 | 有音频 |
|---|---|---|
| `phrase` 条目（含 `sales` / `others` 这类被标成 phrase 的集合词） | 946 | **0** |
| `phrasal verb`（`take off` / `back up sb` 等） | 352 | **0** |
| 单词形 | 25 | 0（其中 20 条词性是 `phrase`） |
| 真·单词 | 5 | 0 |

即：**全包 1298 条 `phrase` / `phrasal verb` 一条音频都没有**；真·单词只差 5 个 ——
`drown`、`hand-held`、`infinitive`、`junior`、`produce`。它们并非被漏抓，
checkpoint 里有官方文件名（`ukdrive028` / `uka30019` / `ukinfec024` / `ukjimda015` /
`ukprod_009`），就是「已知坑」里那 5 个官网音频表查不到、详情页 `<source>` 也是空的
名字 —— **官网自己也播不了**，所以只能回落 YouGlish。

- **正面 🔊**：义项 `a` 有值就播 `app/audio/<a>.mp3`；同一张卡有多个 `a`（如 `increase`
  名词/动词重音不同）会轮流播。离线且没下载时给一句提示，不跳外链。
- **设置 → 发音**：「下载全部发音」把清单逐个写进 `neobridge-audio-v1` 缓存，
  进度条实时刷新，**已存在的直接跳过**，中断后重跑同一次点击即可续传。
- 用 Cache Storage 而不是 IndexedDB：Service Worker 拦同源 GET 就能直接回，
  播放不用先把字节读出来拼 Blob。
- 名字统一小写（`canonicalAudioName()`）：源库里 `UKCLD00440` / `ukcld00440` 其实是
  同一个文件，归一后磁盘、词包、缓存三处严格对得上。

### 首页分区（底部导航）

首页分三区，用底部固定导航（`#tabs`）切换，避免整页不断滚动：

| 分区 | 内容 |
|---|---|
| 复习 | 抽卡复习入口（题数 + 开始），默认停在这一区 |
| 进度 | 最近 7 天、强化记忆名单、当前进度 |
| 设置 | 词包管理（下载内置词包）、发音（下载全部发音，带进度） |

答题时导航随首页一起隐藏，退出后回到出发时所在的分区。一次只有一个 `.pane` 可见。

早期版本首页还带一个「调度冒烟测试」面板和「重新扫描」按钮，**都已删除**：
调度正确性归 `tests/scheduler.test.js`（session 去重、词用尽返回 null 都有断言），
而「重新扫描」只做 `refresh()`（重读 IndexedDB），与杀后台重开 PWA / 刷新页面是同一条
`boot() → openStore() → restorePacks() → refresh()` 路径，无独立价值。

### 首页清单（`ui/lists.js`）

两个清单的**标题行和折叠状态都由 `lists.js` 整体渲染**（`renderWeek` / `renderWrongList` 直接收整个 `#card`），
数量与折叠只有一份实现。

**最近 7 天**：`core/day.js` 的 `lastDays(7, now)` 生成 7 张卡（**新 → 旧，第一张是今天**，越往下越早），
数据来自 `daily` 仓库。卡内排序是**错的排前面，其次按作答时间从早到晚**，
答错的用红色圆点 `●` 标记。标题显示当天作答数（`9月28日 周一（今天） · 10`），
**有词的卡默认折叠**（点标题展开，`▸`/`▾` 标方向；空卡只剩标题行、整卡加 `.day-card.empty` 淡显，不折叠）。
「复制」按钮 `stopPropagation`，点它只复制、不展开。产出

```
word1; word2; word3      # 分号 + 空格，直接粘进背单词工具
```

**强化记忆（错词名单）**：标题 `强化记忆 · N`（空名单只有标题 + 一行「暂无」），
同样默认折叠、点标题展开。卡头右侧有**「复练全部」**按钮（`stopPropagation`，
点了只开一轮、不碰折叠）。判定规则是 `pools.js` 里的

```js
isWrongWord(state, params) = state.wrongs > 0 && state.rightStreak < params.recoverStreak
```

- 错**一次**即入列；**连对 `recoverStreak`（默认 2）次**才出列
- 名单与调度**共用同一条判断**（`poolOf` 也调用它），不会出现「名单要练、调度却不出」的分裂
- 按 `lastWrongAt` 从旧到新排，最久没练的在最上面（只有答错才刷新 `lastWrongAt`，
  答对/答一般不改名次，再答错一次才跳到列表末尾）
- 「复练全部」的题数 = 名单长度、队列只从名单里抽；**抽题顺序仍由调度器加权随机**，
  不是列表顺序（列表顺序只是"从谁开始/阅读顺序"）
- 恢复后该词**仍留在 7 天卡片里**——卡片记录事实，名单只反映「现在该不该重练」

### 题队列为什么一次抽完

`core/queue.js` 在开始时就把整轮抽好，而不是逐题现抽。与逐题抽样**数学上等价**
（session 去重已经保证不重复），换来三件事：进度条能显示「第 3 / 20」、
中途退出只丢队列（进度已逐题落库）、测试能直接断言队列内容。

### 分工

| 文件 | 职责 |
|---|---|
| `core/queue.js` | 抽一整轮（纯函数，`rng` 注入，单测覆盖） |
| `core/day.js` | 日历工具（纯函数，字符串日期，不受时区影响） |
| `ui/session.js` | 状态与流程：作答 → 更新进度 → 落库（`progress` + `daily`）→ 直接跳下一题；`append` 后同帧调 `fitWord()`，横竖屏切换重算 |
| `ui/views.js` | 只把状态画成 DOM，无状态判断；**全部走 `textContent`**（中文释义将来来自 LLM，不能当 HTML 解析）；卡面文案与派生数据由 `ui/card-info.js` 算；`fitWord()` 按卡片可用宽度把正面词缩到单行（`lenClass` 只给字号封顶） |
| `ui/lists.js` | 首页两个清单的标题、折叠状态、一键复制，以及错词名单的「复练全部」入口 |
| `ui/audio-download.js` | 发音：清单（来自词包 `a`）、批量下载进 Cache Storage、正面 🔊 播放 |
| `app.js` | 首页 ↔ 答题页切换，退出时刷新统计与清单；`startSession(size, words)` 接受任意词子集（整包 / 错词名单） |

## 抓取方法（为什么这么做）

站点在 2023 年前后从 Joomla 迁到了 **Bubble.io 单页应用**，旧接口
`POST /wordlists/evp` 已 404，页面内容全部 JS 渲染，直接 HTTP 请求拿不到数据。

逆向后确认：

- **请求体是加密的**（`z/y/x` 三个 base64 块，`encode_data()` 产出），无法跨会话重放
  → 排除纯 HTTP 逆向方案。
- **响应体是明文 JSON**（`POST /elasticsearch/msearch`），`_source` 内含全部字段
  → 只要驱动 UI 翻页，拦截响应即可拿到数据，且比解析 DOM 更完整。

因此脚本的流程是：

1. 用真实浏览器打开页面，勾选 Levels `B1` + `B2`，点 Search
   → 页面报告 `Results: 1 - 20 of 7101`
2. 逐页点 `chevron-right` 翻页，同时监听 `/elasticsearch/m?search` 响应，
   按 `_id` 去重收集 `custom.evp_uk1` 记录
3. 每 10 页写一次 checkpoint，中断后重跑同命令即可续传
4. 过滤等级、组装字段（`evp-lib.mjs`）、写入 SQLite 并构建 `evp_entry`

抓取只在源数据变化时需要；改 schema 后直接 `npm run rebuild` 从 checkpoint 重建。

### 发音文件为什么不能直接拼 URL

词条里带 `audiofilename_text`（如 `UKACCES028`），但 mp3 的真实地址是
**每文件唯一的 CDN 路径**（`/f<毫秒>x<随机>/NAME.mp3`），中间那段随机数拼不出来，
必须查 Bubble 数据类型 `custom.evp_audio_files`（13227 行，`name_text` → `file_file`）。

那个类型的 `/elasticsearch/search` 同样是加密请求体，`scripts/audio-lib.mjs` 把
`encode_data()` 复刻了一遍（算法逆自 `/package/run_js/.../run.js` 里的
`lib-browser/db/obfuscate.js`）：

```
z = AES-256-CBC( pbkdf2(md5, appname+ts, salt=appname, c=7, 32B),
                 pbkdf2(md5, iv,         salt=appname, c=7, 16B), JSON )
y = AES(appname, "po9", `${ts}_1`)   // 服务端解出时间戳
x = AES(appname, "fl1", iv)          // 服务端解出 iv
iv = String(Math.random()), ts = String(Date.now())
```

浏览器那一份只用来取 cookie + 一份真实请求模板（模板里的 `search_path` / `situation`
等字段服务端会校验，现抓现用最稳）。按 `name_text` 排序翻页（每页 400）34 页约 18 秒。

`npm run scrape:audio` → `data/raw/audio-files.json`（存**全表**，以后加 C2 包不用重抓），
`npm run audio` → `app/audio/`（只下源库用得到的 3701 个，断点续传）。

### 已知坑

- **Display 必须固定 20**。下拉里的 `50 / 100 / All` 会触发 Bubble 的懒加载渲染，
  每页只物化约 21 行，剩余记录永远不会被请求。
- **点击 Search 前要清空已收集记录**：页面加载时的默认视图（未筛选，A1–C2 全量）
  会污染进度计数，导致翻页判定提前通过。
- 页面上的 Details 列不是 `<a>` 链接，而是图标按钮，其 workflow 为
  `ChangePage + url_parameters: [{k:"refid", ...}]` —— 这就是 `details_url` 的由来。
- **音频名有 7 个在官网音频表里根本不存在**（`ukdrive028` / `uka30019` / `ukinfec024` /
  `ukjimda015` / `ukprod_009` 等，源站自己写错了）。`scrape-audio-urls.mjs` 对这些
  打开词条详情页、取站点实际播放的那个 mp3，救回 `ukrefre008`（→ `EPD32823.mp3`）和
  `ukreapp021`（→ `UKREAPP020.mp3`）两个；剩下 5 个官网页面上也是空 `<source>`，
  **官网自己都播不了** → `writeDb()` 里 `resolvableAudioName()` 把这 5 个名（共 7 行）
  的 `audio_name` 直接存 **NULL**，词包的 `a` 也是 `null`，卡片喇叭回落 YouGlish；
  原始文件名仍留在 `data/raw/checkpoint.json` 的 `audiofilename_text` 里（源数据不改），
  `npm run rebuild` 会从 checkpoint 记一笔「5 名 / 7 行」，异常不会悄悄消失。
- **音频名大小写混用**：源库有 10 个全小写名字，其中 2 对只差大小写（`ukcld00440` /
  `UKCLD00440`）其实指向同一个文件。一律 `canonicalAudioName()` 归一成小写再落盘，
  否则 Windows（大小写不敏感）和线上托管（敏感）会得到不同的文件集合。
- **老词包（v1）没有 `a` 字段**：此时设置页的发音卡显示红字
  `当前词包 … v1 不含发音数据`、`#status` 同步变红、「下载全部发音」禁用，
  卡片正面的喇叭全部回落 YouGlish。**删除该词包 → 重新「下载内置词包」**即可修好。
  `sw.js` 让 `/data/*.json` 走网络优先，正是为了不让缓存里的旧 `manifest.json`
  把人下回旧包（Playwright 实测：v1 激活 → 红字；重下 → `3701 个发音文件`、
  喇叭变成本地 `<button>`）。

## 版权

数据版权归 Cambridge University Press & Assessment 所有，本站标注 "Terms of Use"。
本项目仅用于**个人离线复习**，请勿二次分发或商用。
