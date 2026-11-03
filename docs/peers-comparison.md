# 记忆类插件逐项对比

日期：2026-11-03。对 sage-mem 2.3.1、dsh-trivium 0.8.3 的实现做了定向阅读（README + 关键模块源码），chaos 一侧是本仓库当前实现。

## 生态坐标

`keywords:dsh-plugin` 在 npm 上共 **12132** 个包（registry search API 实测）。记忆是其中最拥挤的方向之一，至少 20+ 个同类：`memcue-dsh`、`dsh-engramory`、`dsh-memory-tiers`、`dsh-lite-memory`、`stratagate-dsh`、`dsh-fish-memory`、`dsh-deja`、`@try-works/dsh-memory`、`dsh-whale-soul`、`dsh-dafeiyu-life`、`dsh-feed-the-seek` 等。

**chaos 不是这个方向的开拓者，是后来者。**

## 逐项对比

| 维度 | chaos | sage-mem 2.3.1 | dsh-trivium 0.8.3 |
|---|---|---|---|
| 存储形态 | SQLite（`event` 只追加 + `claim` 双时态视图） | markdown 文件 + 索引文件，无数据库 | 图索引 `.tdb`（二进制）+ `trivium.jsonl` 快照 |
| 写入触发 | 自动（`session/event`）+ 工具补写 | 自动观察挂载 + 模型工具写入 | 抽取调度器 `extract-scheduler.js` |
| 抽取 | 规则版（同步兜底）+ 宿主 LLM（异步） | Autodream（离线 LLM 循环） | `extract.js` + 嵌入 |
| 检索 | BM25 + 势能 Φ（承诺压力 / 稀缺性 / 周期共振 / 关系张力） | 两阶段：description 粗筛（≤10 候选）→ 段落 BM25（中文按两字切） | 嵌入向量 + episode 图 |
| 注入 | `system-prompt/assemble`，每轮 200 字符 | 同机制；单会话累计 60KB，含缺口状态卡 | 同机制；`TURN_ADDITIONAL_BUDGET = 300` token |
| 预算粒度 | 每轮 200 字符；**本次新增**单会话累计 600 字符 + 已注入降权 | 单会话 body pool 60KB − 状态卡预留（5%，1–4KB 夹取） | 每轮 300 token；单条 ≤200 字符；超预算整条丢弃（`over-budget`），不截断 |
| 重复注入 | **本次新增**：已注入条目 Φ/R 打 0.35 折，让位但不排除 | 相邻重复问题不重复注入（每会话保留一个签名）；A→B→A 会再次注入 | `turnKeyOf` + `fingerprintOf` 指纹去重 |
| 并发写保护 | **本次新增**：`BEGIN IMMEDIATE` 包住整个写入裁决；ID 由 MAX 序推（不再用 COUNT） | 进程内串行队列；**作者明确写"不是跨进程文件锁，同时开两个 DSH 实例仍可能丢一次"** | 文件级原子写：写临时文件 + `renameSync` 覆盖（同卷原子） |
| 冲突/时间 | 双时态（`valid_from/valid_to` + `tx_from/tx_to`）+ supersede + deferred 不进注入 | 版本守卫：版本变了显式拒绝（`FS_STALE_VERSION`），冲突落 `<state>/conflicts/<id>.json` | `revisions.js` / `revision-graph.js` |
| 写入校验 | 三道门（槽位白名单 / 引文必须在原文 / 值被引文支撑） | 版本守卫 + 写入闸门 | `hygiene.js` |
| 成本模型 | 每轮一次 LLM 调用（自动通道）+ 检索零成本 | 检索纯词法，不调模型；Autodream 离线 | 每轮嵌入调用 |
| 工程契约 | README + 77 个单测 + CI | 冻结的 1.0.0 contract、徽章、文档站 | README + 多个专用模块 |

## chaos 的位置

**站得住的差异**：记忆是"带两个时间维度的主张"，不是"一条文本"。改口时旧值关 `tx_to`、说不清时进 `deferred` 不进注入、每条都必须能回溯到原文的连续片段。sage-mem 的版本守卫解决的是"写入被覆盖"，不是"这条记忆何时为真、何时被推翻"。

**本次补上的两块**：

1. **会话预算帽**——按会话累计注入字符数，到顶后只发缺口提示；已注入过的条目降权而非排除（保留"承诺隔几轮再浮上来"的语义）。
2. **并发写保护**——`ingestClaim` 整体 `BEGIN IMMEDIATE`；ID 从 `MAX` 序推而不是 `COUNT`；`openDb` 只在建库时设 WAL、`migrate` 整段进写锁（这两处是探针实测出来的真实崩溃点，不是推测）。

**仍然落后的**：离线巩固（sage-mem 的 Autodream）、跨进程文件锁（sage-mem 自己也没做）、冻结的公开契约文档。

## 未能验证的部分

- trivium 的嵌入检索与图结构只看了文件结构和常量，没有读 `extract.js`/`embed.js` 的算法细节。
- sage-mem 的 Autodream 与冲突记录的完整流程只读了锁表与 README 说明，没读 `autodream/engine.js`。
- 两个竞品都没有实际跑过（没有安装、没有在真实会话里对比效果）。上表是**代码与文档层面**的对比，不是效果层面的对比。
