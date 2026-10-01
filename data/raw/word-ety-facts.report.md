# 词源事实底稿 · 统计报告

- 生成时间：2026-09-30T22:29:26.019Z
- 词表：app/data/words.v2.json 中 3645 个纯单词（不含 1363 个短语），与 ext.v1.json 键集一致
- 数据源：English Wiktionary（MediaWiki API 批量查询，UA 标识，≤1.5 req/s）
- 事实来源：English Wiktionary, CC BY-SA 4.0
- 产物：`data/raw/word-ety-facts.json`（按词组织的事实底稿）

## 验收指标

| 指标 | 结果 | 门槛 | 判定 |
|---|---|---|---|
| 页面命中率 | 100.00%（3645/3645） | ≥95% | ✅ |
| 有词源段比例 | 95.80%（3492/3645） | ≥85% | ✅ |
| 非空词源正文 | 95.75%（3490/3645） | ≥85% | ✅ |
| 有结构化语链 | 76.46%（2787） | — | — |
| 有构词记录 | 1169 | — | — |
| 来源不明标记 | 88 | — | — |
| 多词源词 | 839（各自带词性） | — | — |
| 语链截断(>3跳) | 878 | — | — |

## 未命中（not_found，共 0）

（无）
## 变体标题命中（5，词表标题 → 实际页面标题）

- cd-rom → `CD-ROM`
- cheers! → `cheers`
- cv → `CV`
- dj → `DJ`
- first-floor → `first floor`

## 页面存在但无 English 段（0）

（无）

## 有页面但无 Etymology 段（153，节选 50）

- addicted
- adopted
- ages
- amazed
- analyse
- animated
- annoyed
- arts
- astonished
- astonishing
- bad-tempered
- balanced
- banking
- behaviour
- belongings
- bombing
- booking
- bothered
- canned
- cd-rom
- cheers!
- coaching
- complicated
- concerned
- conditions
- confusing
- considering
- contents
- convinced
- crossroads
- damaged
- delighted
- depressing
- detailed
- determined
- developing
- disappointed
- disappointing
- disorganized
- distressing
- divorced
- dj
- dressed
- encouraging
- endangered
- engaged
- estimated
- existing
- expected
- facilities

（其余 103 个见 JSON stats.noEtymologyList）

## 来源不明/有争议标记（88）

- all
- amuse
- ban
- bar
- bear
- beg
- boot
- bother
- brave
- cabbage
- calf
- cast
- cause
- cheat
- cod
- consultant
- cosy
- craft
- crash
- cut
- dance
- darling
- dash
- doubt
- draw
- drown
- ease
- enquire
- enquiry
- fade
- fine
- funeral
- glance
- gorgeous
- groom
- guilt
- heaven
- hope
- industry
- inquire
- inquiry
- itch
- jewel
- job
- jug
- kettle
- key
- kit
- lazy
- luck
- make
- moustache
- pan
- panic
- pause
- paw
- penny
- planet
- play
- pot

（其余 28 个见 JSON stats.uncertain）

## 语链中未映射语言代码（待查证，先保留代码原样）

- `gem`: 2
- `gmq`: 2
- `qfa-sub`: 1
- `jam`: 1

## 抽样对拍（已人工核实的标准词）

### abandon  — status: ok
- **Etymology 1** POS: Verb
  - chain: Middle English abandounen ← Old French abandoner ← Late Latin bannum “proclamation”
  - text: From Middle English abandounen, from Old French abandoner, formed from à (Old French “at, to”) + bandon (Old French “jurisdiction, control”), from Late Latin bannum (“proclamation”), bannus (Latin), bandum (Latin), from Frankish *ban, *bann (Proto-West Germanic), from Proto-Germanic *bannaną (“to proclaim, command”) (whence ban (English)), from Proto-Indo-European *bʰeh₂- (“to speak”). See also ban (English), banal (English). ⏎  ⏎ Displaced forleten (Middle English “to abandon”), from forlǣtan (Old English), anforlǣtan (Old English); see forlet (English); and forleven (Middle English “to leave beh …
- **Etymology 2** POS: Noun
  - chain: Middle English abandoun ← Old French abandon ← Old French abondonner
  - text: From Middle English abandoun, from Old French abandon, from Old French abondonner.

### alarm  — status: ok
- **Etymology** POS: Noun, Verb (链已截断至3跳)
  - chain: Middle English alarme ← Middle French alarme ← Old Italian all'arme! “to arms!, to the weapons!”
  - text: From Middle English alarme, alarom (Middle English), borrowed from Middle French alarme, itself from Old Italian — all'arme! (Italian “to arms!, to the weapons!”), ultimately from Latin arma (“arms, weapons”).

### diet  — status: ok
- **Etymology 1** POS: Noun, Adjective (链已截断至3跳)
  - chain: Middle English diet ← Old French diete ← Ancient Greek δίαιτα
  - text: From Middle English diet, dyet (Middle English), diete (Middle English), from Old French diete, from Medieval Latin dieta (“regimen, regulation; assembly”), from Latin diaeta, from Ancient Greek δίαιτα.
- **Etymology 2** POS: Verb
  - chain: Middle English dieten ← Old French dïeter ← Medieval Latin diētāre
  - text: From Middle English dieten, dyeten (Middle English), diȝeten (Middle English), from Old French dïeter and Medieval Latin diētāre.
- **Etymology 3** POS: Noun (链已截断至3跳)
  - chain: Middle English diet ← Old French diete ← Latin diēs “day”
  - text: From Middle English diet, dyet (Middle English), from Old French diete, from Medieval Latin diēta, diaeta (Latin “a public assembly; set day of trial; a day's journey”), from Ancient Greek δῐ́αιτα (“way of living, living space; decision, judgement”), influenced by Latin diēs (“day”).

### fiction  — status: ok
- **Etymology** POS: Noun (链已截断至3跳)
  - chain: Middle English ficcioun ← Old French ficcion “dissimulation, ruse, invention” ← Latin fingō “to form, mold, shape, devise, feign”
  - text: From Middle English ficcioun, from Old French ficcion (“dissimulation, ruse, invention”), from Latin fictiō (“a making, fashioning, a feigning, a rhetorical or legal fiction”), from fingō (Latin “to form, mold, shape, devise, feign”). Displaced native lēasspell (Old English); see feign (English), feint (English), figment (English).

### urgent  — status: ok
- **Etymology** POS: Adjective
  - chain: Middle French urgent “pressing, impelling” ← Latin urgēns ← Latin urgeo “to press”
  - composition: suffix: urge + ent (English)
  - text: Borrowed from Middle French urgent (“pressing, impelling”), from Latin urgēns, from urgeo (Latin “to press”), from Proto-Indo-European *werǵʰ- (“bind, squeeze”). Equivalent to urge + ent (English). Related to würgen (German “to strangle”), verzti (Lithuanian “ver̃žti”), - (Russian) (poetic) отверза́ть (Russian “to open”), otwierać (Polish “to open”)) and worry (English), wring (English), wreak (English), wreck (English).

### they  — status: ok
- **Etymology 1** POS: Pronoun, Determiner, Verb, Noun
  - chain: Middle English þei ← Old Norse þeir
  - text: From Middle English þei, borrowed in the 1200s from Old Norse þeir, plural of the demonstrative sá (Old Norse) which acted as a plural pronoun. Displaced native he (Middle English) from hīe (Old English) — which vowel changes had left indistinct from he (Middle English “he”) — by the 1400s, being readily incorporated alongside native words beginning with the same sound (the (English), that (English), this (English)). Used as a singular pronoun since 1300, e.g. in the 1325 Cursor Mundi. ⏎  ⏎ The Norse term (whence also þeir (Icelandic “they”), teir (Faroese “they”), de (Danish “they”), de (Swedish  …
- **Etymology 2** POS: Pronoun
  - chain: English the'e ← English there
  - text: From earlier the'e (English), from there (English).

### peanut  — status: ok
- **Etymology** POS: Noun, Verb
  - chain: (空)
  - composition: compound: pea + nut (English)
  - text: From pea + nut (English), perhaps a folk etymology of pinda (English), pinder (English) (still found in Southern US dialects).

## 裁剪与红线执行说明

- 语链：lineage 模板（inh/bor/der/learned borrowing/calque 等）按文档顺序提取；
  `Proto-*`（代码含 `-pro` 或名以 Proto- 开头）与 `*星号重建形` 一律剔除；
  cognates（cog/noncog/ncog）不进链；超过 3 跳时截断（第 3 跳已是拉丁/希腊则换成链上最后一个拉丁/希腊跳），
  截断的词标记 `abridged:true`。正文 `text` 保留 Wiktionary 原文全量（忠实底稿，裁剪规则只作用于结构化链）。
- 来源不明：仅按正则命中 Wiktionary 明确措辞（unknown/unclear/uncertain/obscure/disputed），
  标 `uncertain:true` 并附原句 `uncertainNote`；绝不推断补全。
- 查不到：`status:not_found`，无任何字段。
- 语言名：仅使用已核实映射（Wiktionary 词条/页面译名标签逐条查证）；未映射代码原样保留在 `code`/`lang` 字段
  （JSON stats.unmappedChainCodes 清单，保留代码即为如实记录、不编造译名）。
- text 字段来源（etymologies[].textSource）：
  - `prose`：Wiktionary 词源段原文逐字保留（大多数词）；
  - `tree-rendered`（493 词）：该词源段无散文正文、只有 `{{ety}}/{{etymon}}` 树模板，
    text 由模板结构**机械渲染**而成（如 "Borrowed from Old French X, from Latin Y"），事实全部来自模板参数、无一字编造；
  - `chain-rendered`（0 词）：正文无散文、仅有 lineage 模板，text 由已抽取的语链机械渲染。
  改写 LLM 应以 chain/composition 结构化字段为事实基准，text 仅作行文参考。
- 变体标题：词表标题在 Wiktionary 无对应 English 段时，改查已核实的变体标题页（variant-pages.json），
  命中条目标 `viaVariant:true` + `variantTitle`（词表标题），`page` 为实际页面标题，可核查跳转关系。
