# Her 中文记忆检索对照实验

测试日期：2026-10-15。结论：**当前关键词工具契约下，保留 LIKE + keywords 足够支持 MVP；需要更稳健地接受自然问句时，优先升级 Intl.Segmenter + FTS5。本轮没有足够收益支持引入 nodejieba。**

这次实际运行了三条检索链路，并额外保留 nodejieba 默认 HMM 配置作为敏感性对照。没有修改 Her 产品代码、依赖或正式数据库。

## 1. 数据与公平性

语料是贴近 Her 个人助手场景的全合成数据，不包含真实用户记忆：

- 84 条记忆：76 条 active，8 条 superseded；全部查询只检索 active。
- 72 个问题：60 个有直接答案，12 个无答案。每个问题有人工审查的相关记忆 ID 和判断理由。
- 覆盖个人偏好、称呼及习惯更正、情绪支持约定、项目别名、中英混合技术名、近期经历、未来计划、单字中文、文件名/路径/特殊字符。
- 正例分类数量：更正 8、偏好 5、近义表达 5、约定 5、项目别名 4、技术 9、近期经历 8、未来计划 6、特殊字符 6、短中文 4。
- 无答案包含未记录的主题、同主题的未知属性、计划的未知结果、相似但不存在的字面标识。

每个问题准备两种输入，三个方案使用相同输入、相同 content 与 keywords：

| 输入 | 用途 | 示例 |
| --- | --- | --- |
| keywordQuery | 主评测，接近当前 recall 工具的关键词契约 | `甜点 口味 偏好` |
| naturalQuery | 压力测试，直接传入用户整句；超出当前 LIKE 的输入契约 | `给我买甜点的话，什么类型更合口味，什么要避开？` |

关键词是人工代理，编写者能看到语料；没有调用真实 LLM 改写问题。关键词中不提前注入问题未知的答案，但其质量仍可能高于实际模型输出。语料和标签在首次检索前冻结，之后未按结果修改。

冻结 SHA-256：`b01bcee14dd04316815cbfe00c069ed1646fe3d703b680013656d070ef761cb3`。

本实验比较的是完整检索链路：LIKE 使用命中词数排序，FTS 使用 BM25。因此 LIKE 与 FTS 的差异不能全部归因于分词。Intl 与 jieba 的差异还包含搜索模式的重叠词扩展；本轮没有拆分消融实验。

## 2. 实现与环境

| 方案 | 索引与查询处理 | 排序 |
| --- | --- | --- |
| LIKE + keywords | 空白及中英文逗号切词；转义 `%`、`_`、`\`；每个词在 content 或 keywords 中做子串匹配；词间 OR | 命中查询词数降序，id 降序 |
| Intl.Segmenter + FTS5 | `zh-CN`、`granularity: word`、只保留 isWordLike；写入预分词文本，查询也分词；FTS5 unicode61；每个查询词加引号转义后 OR | BM25，content/keywords 权重均为 1；同分 id 降序 |
| nodejieba + FTS5 | `nodejieba@3.5.8`、`cutForSearch(text, true)`，开启 HMM，保留含字母或数字的词；其余与 Intl 一致 | 同上 |
| nodejieba 默认配置对照 | `cutForSearch(text, false)`，关闭 HMM；其余相同 | 同上 |

所有方案最多返回 10 条，同时报告 @5 与 @10。没有自定义词典、额外同义词扩展、停用词表、召回阈值或重排模型。所有方案都使用相同的人工 keywords 别名。

在看标签检索结果前，发现 nodejieba 3.5.8 默认关闭 HMM 会把 `TypeScript` 拆为单字母，而开启后保留为一个词。因此主方案显式开启 HMM，默认配置保留为对照；未在结果出来后挑选最佳开关。

运行环境为 Apple M5、10 核、24 GiB 内存、macOS/Darwin 25.6.0、arm64：

| 运行方式 | Node | SQLite | ICU |
| --- | --- | --- | --- |
| 系统 Node | 24.14.0 | 3.52.0 | 78.2 |
| Electron 44.7.0，RunAsNode 完整基准 | 24.21.0 | 3.53.4 | 78.2 |

nodejieba 在独立临时目录安装，实际测试二进制为本机源码编译版本。正式项目 package.json、package-lock.json、electron.vite.config.ts 未修改。官方 npm registry 当时连接超时，安装使用本机配置的 npmmirror；独立锁文件保留了版本和包完整性校验值。

下表以更接近 Her 的 **Electron RunAsNode** 结果为主。另用真实 Electron browser/main 进程验证同一 native 模块加载、分词、SQLite FTS5 建表与查询成功；这不是完整 Electron 主进程性能测试，也不是应用打包验收。

## 3. 召回质量

指标定义：Hit@k 是至少找到一条相关记忆的正例比例；Recall@k 是各正例“找到相关条数 / 全部相关条数”的平均；MRR@k 是首条相关记忆排名倒数的平均，未命中为 0。后三者都只对 60 个有答案问题计算。

### 关键词输入：符合当前工具契约

| 方案 | Hit@5 | Hit@10 | Recall@5 | Recall@10 | MRR@5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| LIKE + keywords | 60/60 | 60/60 | 99.17% | 100.00% | 0.9394 |
| Intl + FTS5 | 60/60 | 60/60 | 99.44% | 99.44% | 0.9833 |
| nodejieba + FTS5，HMM 开 | 59/60 | 60/60 | 97.78% | 99.44% | 0.9667 |
| nodejieba + FTS5，HMM 关 | 60/60 | 60/60 | 99.44% | 99.44% | 0.9589 |

按设计中的实际上限 10 条，三个主方案都能在每个正例中找到至少一条相关记忆。Intl 的首条相关结果更靠前，但有些短词子串关系会丢失；不能把一个 @5 漏例解释成 nodejieba 普遍更差。

### 自然问句：输入鲁棒性压力测试

| 方案 | Hit@5 | Hit@10 | Recall@5 | Recall@10 | MRR@5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| LIKE + keywords | 23/60（38.33%） | 23/60 | 38.33% | 38.33% | 0.3361 |
| Intl + FTS5 | 60/60 | 60/60 | 98.61% | 100.00% | 0.9611 |
| nodejieba + FTS5，HMM 开 | 60/60 | 60/60 | 99.17% | 100.00% | 0.9722 |
| nodejieba + FTS5，HMM 关 | 60/60 | 60/60 | 99.17% | 100.00% | 0.9367 |

自然句中大量没有空白的中文被 LIKE 视为很长的一个查询词，难以匹配。这个差距说明预分词有助于接受整句输入，**不是当前 LIKE 工具在真实 agent 对话中只有 38% 准确率**。真实模型能否生成合适关键词，本轮未测。

### 噪声与无答案问题

“返回相关占比”按所有正例 top 5 中的相关条数 / 实际返回条数计算，是 micro 指标，不是固定分母的标准 Precision@5。无答案候选率则单独检查 12 个负例是否返回了任何候选。

| 方案 | 关键词返回相关占比 | 关键词无答案仍返回候选 | 自然句返回相关占比 | 自然句无答案仍返回候选 |
| --- | ---: | ---: | ---: | ---: |
| LIKE | 64/183（34.97%） | 8/12 | 23/45（51.11%） | 3/12 |
| Intl + FTS5 | 64/227（28.19%） | 9/12 | 63/300（21.00%） | 12/12 |
| nodejieba + FTS5，HMM 开 | 63/216（29.17%） | 8/12 | 64/300（21.33%） | 12/12 |
| nodejieba + FTS5，HMM 关 | 64/245（26.12%） | 8/12 | 64/300（21.33%） | 12/12 |

FTS 对整句做宽松 OR 会召回很多共享“我、的、喜欢”等词的记忆。因此高 Hit 不代表整包上下文都相关；LIKE 较高的自然句返回相关占比也不能抵消其大量漏召回。没有方案仅靠这套词法检索就能可靠判断“记忆里没有答案”。返回同主题背景不等于模型幻觉，本轮未测最终回答是否编造。

## 4. 能解释取舍的案例

| 问题 | 实际观察 | 对 Her 的意义 |
| --- | --- | --- |
| Q10：`甜点 口味 偏好` | LIKE 把稳定的甜点偏好放第 6，蛋糕经历放第 3；Intl/jieba 把稳定偏好放第 1，蛋糕经历放第 3 | 同分按新 id 排序会让泛词和近期干扰项挤掉重要偏好；FTS 的排序有价值 |
| Q15：`没电了 回应` | HMM 开启时查询切为 `没电 / 了 / 回应`，记忆中带引号的“没电了”切为 `没 / 电 / 了`；只靠“了”匹配，正确记忆排第 10。Intl 第 1，LIKE 第 2，默认 jieba 第 1 | 新词识别可能造成查询与正文词边界不同；不能只检查单独几个分词示例 |
| Q60：`茶` | LIKE 找到茶口味、泡茶习惯、茶室计划共 3 条；两种 FTS 只找到前 2 条 | FTS 完整词匹配不自动等价于子串检索，`茶`不会自动命中`茶室` |
| Q54：`C++ 入门 清单` | 三方案正确记忆均第 1；但两个 FTS 都把 C#、Windows 路径等含 C 的条目带回来 | jieba 即便输出 `C++`，后续 unicode61 仍会处理标点；分词结果不等于最终索引 token |
| N01：`香水 香调`，没有记录 | LIKE/jieba 无候选；Intl 将“香调”拆成“香 / 调”，召回了包含“调”的干扰项 | 更细的分词能增加召回，也会引入无答案噪声 |
| N11：`南京 居住 小区`，只记录了城市 | 三方案都返回城市背景，没有小区地址证据 | 召回相关主题不足以回答更细的属性，需要回答阶段核对证据 |

系统 Node 和 Electron 的主要质量指标一致，但不是所有候选完全相同：Intl 对 Q52 `foo_bar.md 文件` 在 Node 中输出 `foo_bar.md / 文件`，Electron 输出 `foo_bar / md / 文件`；N09 及对应自然句也存在边界或排序差异。两者公开的 ICU 版本都是 78.2，不能简单归因于 ICU 版本号。应在 Her 实际运行时验证分词和重建索引，不能只在开发 Node 下验收。差异明细见 runtime-comparison.json。

## 5. 性能与资源成本

查询计时包含查询分词、参数绑定和检索，不含 LLM、网络、IPC、磁盘 I/O。使用内存 SQLite；每个规模每种方法预热 2 轮，再运行 72 个关键词查询 × 8 轮，得到 576 个样本。各方案及两个运行时顺序执行。

1,000 和 10,000 条语料由原 76 条有效记忆重复生成、重新赋 id，只测负载变化，**没有增加质量评测样本量**。重复词分布不同于真实增长语料，绝对延迟只作本机参考。

Electron RunAsNode 查询延迟，单位 ms（中位数 / P95）：

| 有效记录数 | LIKE | Intl + FTS5 | nodejieba + FTS5，HMM 开 |
| --- | ---: | ---: | ---: |
| 76 | 0.037 / 0.051 | 0.015 / 0.030 | 0.013 / 0.030 |
| 1,000 | 0.281 / 0.368 | 0.034 / 0.142 | 0.029 / 0.135 |
| 10,000 | 2.584 / 3.315 | 0.195 / 1.214 | 0.173 / 1.144 |

系统 Node 的 10,000 条 P95 分别是 5.139 / 1.194 / 1.171 ms，方向一致。当前小规模下三个方案都很快；nodejieba 相对 Intl 的微小绝对延迟差距不足以支撑为此引入原生依赖。这里的 P95 是固定查询集上的延迟分布，未做跨机器统计显著性推断。

新进程内的分词器准备时间（初始化 + 首次分词）及 RSS 增量，每项 3 个独立进程取中位数：

| 方案 | Electron 准备时间 | Electron RSS 增量 | 系统 Node 准备时间 | 系统 Node RSS 增量 |
| --- | ---: | ---: | ---: | ---: |
| LIKE | 0.05 ms | 0.11 MiB | 0.16 ms | 0.05 MiB |
| Intl | 4.31 ms | 4.13 MiB | 7.67 ms | 3.80 MiB |
| nodejieba，HMM 开 | 241.19 ms | 181.14 MiB | 236.29 ms | 277.31 MiB |
| nodejieba，HMM 关 | 253.51 ms | 181.14 MiB | 231.15 ms | 277.22 MiB |

这是当前标准 nodejieba 包 `load()` 的完整加载成本，包含默认词典及额外提取器，首个 cut 没有再次加载；不是“理论最小中文分词器内存”。RSS 受运行时和分配器影响，不能外推为所有平台固定值。准备时间不包含 OS 创建进程和静态导入 node:sqlite 的时间，也不是整个 Her 的启动时间。

原始结果还记录 buildMs 和 databaseBytes。buildMs 包含每次构建时 tokenizer 初始化，nodejieba 每次显式 load 会重建对象，不能视为复用已加载分词器后的纯索引写入耗时。databaseBytes 是临时数据库页数 × 页大小；FTS 表存预分词文本，没有叠加真实产品必须保留的原文 memories 表，不能直接当作 Her 完整磁盘占用。

## 6. 选型建议与边界

1. **当前 agent-memory-tools MVP 保留 LIKE + keywords。** 它符合明确要求模型生成关键词的契约；本轮 @10 既覆盖所有正例，也找齐全部已标注相关条目，小规模性能充足。不要因为自然句压力测试的 38.33% 就判定当前设计失效。
2. **若要现在升级检索，首选 Intl.Segmenter + FTS5。** 主要收益是自然句输入鲁棒性、更好的首条相关结果排序和更低的规模增长成本。它在本轮没有输给 nodejieba 的决定性质量差距，也不增加外部分词 native 包。升级前应明确短词、路径和代码名的精确匹配语义；必要时保留原文 LIKE 的补充通道，具体融合规则需要再测，不属于本次已验证方案。
3. **暂不引入 nodejieba。** 本轮自然句 MRR 略高、关键词 MRR 略低，Hit 没有稳定优势，却有明显默认加载成本。只有积累真实失败样本，证明自定义领域词典或搜索模式能持续改善召回，再考虑它。HMM 开关不是单向质量提升，需同时回归中英混合词和上下文边界。
4. **下一轮优先验证真实模型的 recall 查询与无答案行为。** 当前样本较小，人工 keywords、唯一项目名和日期会使 Hit 接近上限；没有缺失/错误 keywords 的专门消融、纯同义改写隔离实验，也没有 embedding、重排、记忆抽取、自动更正、删除一致性或最终回答评测。别把 60/60 外推成真实用户的记忆准确率。

真实 Electron 主进程 smoke 已通过；ASAR 打包、签名、公证、其他 OS/架构以及实际用户长时间会话未测试。现有原始 JSON、数据和脚本足以审查这次本机检索结论，不能替代产品集成验收。

## 7. 复现与产物

从 Her 根目录执行，依赖放临时目录，不改变应用依赖。锁文件当前使用 npmmirror tarball 地址；源码构建需要本机编译工具和可用 Node headers。

```bash
bench_dir="$PWD/openspec/changes/agent-memory-tools/benchmarks"
bench_deps="$(mktemp -d /tmp/her-memory-benchmark.XXXXXX)"
cp "$bench_dir/dependencies/package.json" "$bench_deps/package.json"
cp "$bench_dir/dependencies/package-lock.json" "$bench_deps/package-lock.json"
npm_config_build_from_source=true npm ci --prefix "$bench_deps" --no-audit --no-fund

node "$bench_dir/run.mjs" --nodejieba-root "$bench_deps" \
  --label system-node --output /tmp/her-memory-results-node.json

ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  "$bench_dir/run.mjs" --nodejieba-root "$bench_deps" \
  --label electron-run-as-node --output /tmp/her-memory-results-electron.json

env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  "$bench_dir/electron-smoke.cjs" --nodejieba-root "$bench_deps"
```

不要并行执行两组性能测试。重复运行的耗时和 RSS 会波动；实际 Electron 与 Node 版本变化也可能改变分词结果。

同目录文件：

- `dataset.json`：全部记忆、问题、gold IDs、判断理由、数据限制说明。
- `run.mjs`：检索实现、数据校验、转义检查、指标计算、冷启动和规模实验。
- `results-node.json`、`results-electron.json`：完整版本、数据/脚本哈希、逐题 token、top 10、各分类汇总、每次冷启动样本。
- `electron-smoke.cjs`、`results-electron-main.json`：真实主进程的加载和 FTS5 冒烟验证。
- `runtime-comparison.json`：两个运行时的 token 与候选差异摘要。
- `tokenization-cases.json`：英文词和“没电了”在 HMM 两种配置下的切分证据。
- `dependencies/package.json`、`dependencies/package-lock.json`：独立固定依赖。

验证记录：两个完整基准进程及真实 Electron 主进程 smoke 均以退出码 0 完成；active 过滤、LIKE 字面转义与基础召回断言通过。独立审查按原始逐题结果重新计算全部汇总指标，结果一致。未运行 Her 全量测试，因为本次没有改变应用行为。
