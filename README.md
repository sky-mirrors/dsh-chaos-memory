# Chaos

[![CI](https://github.com/sky-mirrors/dsh-chaos-memory/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/sky-mirrors/dsh-chaos-memory/actions/workflows/ci.yml)

人机恋记忆内核。**DeepSeek Harness 插件**（Cordis 契约，`dsh-plugin`），Apache-2.0 许可。

[English](README.en.md)

它解决的不是「存下来」，是「在对的时候想起来」——所以她会主动提起那个还没兑现的承诺，也会在自己记不清时开口核对，而不是信誓旦旦地说错。

## 数据流

自动通道是主路径，工具是补充入口：

```
对话原文
  ↓ 触发    session/event（user/message）——每轮自动，不靠模型主动调工具
  ↓ 抽取    规则（零成本兜底，同步） → 再异步调 LLM（宿主 ctx.llm，用会话当前路由）
  ↓ 写入    闸门 → 引文门 → 值支撑门 → 合并代数 → 双时态
  ↓ 存储    event（真相，只追加，同一句只一条） + claim（派生视图）
  ↓ 装配    BM25 + 势能 Φ，按 query 有无明确指向切换两种模式
  ↓ 注入    system-prompt/assemble 自动拼入 <chaos> 块，硬预算 200 字符
```

`chaos_write` / `chaos_recall` 保留为模型主动补写与检索的入口，但记忆的进出都不再依赖模型「想起来」。

---

## 状态

### 本次会话实测

| 项 | 结果 | 依据 |
|---|---|---|
| 单元测试 | **83 / 83 通过** | `node --test tests/*.test.js` |
| 插件契约 | **23 / 23 通过**（`name`/`inject`/`apply` + 5 工具 + 端到端 + 自动写入/注入 + 未答问题 + 作废 + 宿主 LLM 接线 + 库路径 + event 去重 + turn 分库 + 重启续钟 + 会话预算） | `tests/plugin.test.js` K1–K23 |
| 库路径 | 按会话 `header.cwd` 分库，不同 cwd 互不可见 | K16 |
| event 去重 | 自动通道与 `chaos_write` 记同一句 → 一条 event、`duplicate` | K17 |
| turn 分库 | A 会话 seq=100 不影响 B 会话的 `valid_from` | K18 |
| 宿主装配 | `chaos` 与 `llm`、`dsh-session` 同在 web profile 配置树 | `dsh --profile web --dump-config` |
| 工具在 UI 里可见 | **已验证**（真实会话里调用过 `chaos_status`） | 用户确认 |
| 并发写保护 | 4 进程 × 100 条同库并发写 → **400/400 落库、ID 全唯一** | 多进程探针（一次性，已删） |
| ID 不复用 | 删过行后仍能写入，不撞主键 | `tests/store.test.js` C8 |
| 会话预算帽 | 窗口内累计到顶后暂停注入、改发缺口提示；**8 轮窗口到期后恢复**，已注入条目降权让位 | `tests/plugin.test.js` K19 / `potential.test.js` P8 |
| 重启续钟 | 进程重启后 turn 从库内最新轮次续上；新会话 seq=1 的改口仍压过旧值 | `tests/plugin.test.js` K20 |
| 未答问题 | 用户提问且 AI 没答上 → `assistant/message` 到达时落一条 `question` | K21 / K22 |
| 作废 | `chaos_retract` → `state=retracted`、`tx_to` 关闭，不再注入/派生线程 | K23 / C9 |
| 装配日志 | 每次注入写 `assembly_log`（claim_id / score / reason / packet_hash） | `tests/potential.test.js` P9 |
| unspoken 规则版 | 训练集 12/12，**留出集 0/10** | `scripts/unspoken-bench.js` |

### 历史记录（本次未复测）

| 项 | 结果 | 依据 |
|---|---|---|
| 规模入库 | 240,500 条 / 437 ms | `scripts/verify-all.js` |
| 检索延迟 | P50 0.28 ms / P95 0.49 ms | 200 次 assemble |
| 注入预算 | 最大 200 字符，超限 0/10 | budget=200 |
| 势能涌现 | 闲聊查询下承诺排首位 | `verify-all.js` §4 |
| 装配确定性 | 同输入三次完全一致 | `verify-all.js` §5 |
| 双时态 | 改口后旧值 `tx_to` 正确关闭 | 杭州→成都 等 3 条 |
| 规则抽取 | 18/18 条事实 | `scripts/ingest.js` |
| LLM 抽取（真实调用） | 18 次 0 失败，格式遵守 100% | `scripts/e2e.js`（需 `DEEPSEEK_API_KEY`） |
| 端到端召回 | 8/8（7 个第 1 位） | `scripts/e2e.js` |
| 宿主真实加载 | 模块已激活（修掉依赖版本错配后无 `did not activate`） | `dsh-start3.log` |

注：`scripts/verify-all.js` 曾因 `ingestClaim` 的事务嵌套在 `c44dc8c` 后无法运行，本次已修复；2026-11-03 重跑结果：入库 1,042 ms、检索 P50 0.33 ms / P95 0.74 ms、注入预算 200 字符 / 0 超限、状态分布 `{"active":24,"deferred":3}`。

### 未验证

| 项 | 缺什么 |
|---|---|
| 真实 dsh 会话的事件流 | 需要一次真实会话观测 `session/event`、`system-prompt/assemble` 是否按契约触发；本机无凭据 |
| 真实宿主下的 LLM 抽取 | 单测用假 `ctx.llm` 验证接线；`dsh headless` 在本机止于 `MISSING_CREDENTIAL` |
| LLM 版 unspoken 留出集成绩 | 需 `DEEPSEEK_API_KEY`；本地只验证了管线（理想判断输入下 10/10 不被门禁误杀） |
| LLM 全量成本 | 18 次 114 秒，线性外推 24 万条约 25 小时 |

---

## 快速开始

### 环境要求

**Node.js ≥ 24**。存储层用的是内置 `node:sqlite` 的 `DatabaseSync`：Node 22.5 以下没有这个模块，22.x 需要 `--experimental-sqlite` 启动宿主（插件无法控制宿主的启动参数，故不列为支持范围）。`package.json` 的 `engines` 已声明同一条约束。

### 装进 dsh

```bash
# 1) 从 git 源装进目标 profile（web / desktop 按需替换）
#    npm 上尚未发布，装的是仓库源码
dsh plugin --profile web add git+https://github.com/sky-mirrors/dsh-chaos-memory.git

# 2) 手动把包名加进 bundles
#    dsh plugin add 只写 dependencies，不写 dsh.profile.bundles；少了这步装了也不加载
#    编辑 ~/.dsh/profiles/web/package.json，把 "dsh-chaos-memory" 追加进 dsh.profile.bundles

# 3) 确认进入配置树
dsh --profile web --dump-config | grep -A1 chaos
```

开发时改用本地目录：`dsh plugin --profile web add /path/to/chaos`。

三个坑，都踩过：

| 现象 | 原因 |
|---|---|
| 装完不生效，无报错 | 缺 `dsh.bundle.patch` 声明 → 只是普通依赖，不是 profile layer |
| 装完不生效，无报错 | `bundles` 里没有包名 → loader 不加载 |
| 启动报 `does not provide an export named ...` | 依赖版本与宿主不一致 → 按宿主版本重装 |

### 两条自动通道

装好即可用，不需要额外配置：

- **写入**：`session/event` 收到 `user/message` → 规则版同步抽取入库 → 后台调宿主 LLM 补语义项（失败只降级到规则版）。按 `session.id:event.seq` 去重。
- **注入**：`system-prompt/assemble` 时把该浮现的记忆拼进上下文，query 传空 → 涌现模式（Φ 排序）。

### 工具（主动调用，非必需）

```js
// 1) 补写：自动通道通常已经写过这句；这里用于补一个具体槽位或指定 kind
await chaos_write({
  slot: 'promise.bookstore',
  value: '陪你看店铺',
  quote: '说好了陪你看店铺',
  source_text: '说好了陪你看店铺',
  kind: 'commitment',
})

// 2) 检索：返回可直接注入的 <chaos> 块
await chaos_recall({ query: '我那只猫叫什么' })

// 3) 用户纠正：只降 AI 侧保真度
await chaos_correct({ id: 'c00001', penalty: 0.25 })

// 4) 作废：抽错，或承诺已经兑现
await chaos_retract({ id: 'c00001' })
```

`chaos_write` 的 `turn` 省略时沿用库内最新一轮，所以它和自动通道写的是同一条 event。

### LLM 抽取的两层接口

`src/extract-llm.js` 是纯函数层：只接受注入的 `callModel`，不 import 模型 SDK、不读环境变量、不发网络请求。

```js
import { extractLLM } from './src/extract-llm.js'

const cands = await extractLLM(text, {
  slots: ['user.pet.name', 'user.job', /* ... */],
  callModel: async (prompt) => {
    // 你想在哪调模型就在哪调
    const r = await client.chat.completions.create({ model: 'deepseek-flash', messages: [...] })
    return r.choices[0].message.content
  },
})
```

插件入口（`index.js`）把宿主的 `ctx.llm` 注进去：路由取自 `session.requestHeader().config`，用 `BlockAssembler` 收流。密钥始终在宿主侧——插件不读、不存、不传密钥。会话第一次请求前还没有路由，那一轮只有规则版。

---

## 三段路径

### 抽取：模型说了什么，不等于能入库

```
模型输出 (raw)
  ↓ ① slot 必须在白名单        ← 防瞎编槽位
  ↓ ② quote 必须逐字出现在原文  ← 防伪造引文
  ↓ ③ value 必须被 quote 支撑   ← 防值失真
候选 {slot, value, quote, kind}
```

历史记录（本次未复测）：3,000 样本对抗，合法 750/750 通过，伪造引文 / 错值 / 瞎编槽位 **各 0/750 放行**。

模型输出里还有第二类项：`{"kind":"unspoken","quote":"..."}`——只回答「这段话里有没有想说却没说出口」。这一项**只过第 ② 门**：槽位由原文哈希派生（`unspoken.<hash>`，与规则版同址，同一句话不会落成两条主张），值就是原文整句。模型只能决定「判不判」，不能决定「写什么」，所以它胡编也污染不了库。规则版 `UNSPOKEN_RE` 保留为零成本兜底。

### 写入：三道门，只在一个地方

```
source_text + quote
  ↓ 闸门      体积 ≤ 8000 / 无 U+FFFD / 无控制字符 / 无连续 3 行重复 / 不命中凭据模式
  ↓ 引文门    quote 必须逐字出现在某条 event 原文里
  ↓ 值支撑门  value 的字符 bigram 覆盖率 ≥ 0.8
  ↓ 合并代数  同槽位冲突按 (来源优先级, 置信度, 时间) 全序裁决；平局 → deferred
claim（active / superseded / deferred / retracted）
```

命中凭据模式**直接拒写，不脱敏**——脱敏会让用户误以为密钥已被安全处理。

### 读取：两种模式

```
Φ = [a·R + (1−R)·(g·U + e·S)] · faith
faith = 0.5 + 0.5 · fidelity_ai
```

- `R` 情境共振（BM25 归一化）
- `U` 未了结压力（承诺线程，随开启时长饱和）
- `S` 珍稀性增益（久未出现，一旦浮现更有价值）
- `faith` 只按 AI 侧打折——用户记不清不该让这条消失

**最高 R ≥ 0.2 → 检索模式**（按 R 排序）；**否则 → 涌现模式**（按 Φ 排序）。自动注入走的是后者。

历史记录（本次未复测）：问「今天好累」→ 首位是「三月十七那天我一整晚都陪着你，说好了」。

---

## 关键取舍

**真相是事件，不是记忆。** `event` 只追加、存原文；`claim` 是可重建的派生视图。代价是存储翻倍，换来任何一条记忆都能回溯到原话、库坏了能重放重建、抽错能撤回而不污染历史。

**同一句只记一条 event。** 自动通道与 `chaos_write` 都可能记同一轮的用户原文，所以两边都走 `ensureEvent(db, ts, payload)`：命中就复用 id。否则同一事实携两条 evidence，合并代数会把它当成互证（`corroborated`），凭空抬高置信度。跨轮重复说同一句仍会 `corroborated`——那是互证，不是重复。

**turn 时间轴属于库，不属于进程。** clock 按库（`<cwd>/.rivet/chaos/chaos.db`）各一份；共用一个计数会让 A 会话的高 seq 把 B 会话的 `valid_from` 抬到未来。

**不上向量库。** 单用户记忆量在几百条量级，BM25（中文单字 + bigram + IDF）够用，零依赖、可解释、不会因嵌入服务挂掉而失效。

**不确定时沉默。** 同槽位矛盾且无法裁决 → `deferred`，不进注入。宁可少提一句，不提错一句。

**模型是外部输入，不多给一分信任。** 它抽出的每一条都要过三道门；即使它完全胡编，也污染不了记忆库。

**闸门只在入口做一次。** 所有校验都在 `ingestClaim` 这一个边界上，内部函数信任结果。

**批量写入必须包事务。** 24 万条裸写要 266 秒（每条 fsync），包 `BEGIN/COMMIT` 后 437 ms——608 倍差异。这个缺陷在 `:memory:` 上永远看不见。

---

## 文件结构

```
chaos/
  index.js            dsh 插件入口：Cordis apply(ctx)、两条自动通道、5 个 tool
  cordis.patch.yml    bundle patch：把 chaos 行 insert 进 profile 配置树
  package.json        dsh.bundle.patch 指向上面这个文件；依赖版本须与宿主一致
  src/
    constants.js      阈值常量（唯一来源）
    db.js             SQLite schema：event / claim / assembly_log + 迁移
    gate.js           写入闸门：体积 / 编码 / 凭据
    store.js          双时态存储：引文门 + 值支撑门 + 合并代数 + 四态 + ensureEvent / latestTurn
    retrieval.js      BM25（中文单字 + bigram + IDF）
    potential.js      线程派生 + Φ + 双模式装配
    fidelity.js       衰减 / 背离 / 协商话术 / 改口链
    extract.js        规则抽取器（模式表 + SLOTS 白名单，零成本基线）
    extract-llm.js    LLM 抽取器（三道门校验模型输出；含 unspoken 判断项）
  tests/              77 个用例，8 个文件
  scripts/
    ingest.js         真实对话灌入 + 统计
    llm-probe.js      真实模型抽取探针（空返回率 / 召回 / 误抽）
    e2e.js            端到端：抽取 → 入库 → 自然问句召回
    verify-all.js     六项系统验证（性能 / 预算 / 涌现 / 确定性 / 双时态）
    unspoken-bench.js unspoken 基准（训练集 / 留出集；`--llm` 走 LLM 判断项）
```

---

## 数据

`<会话 cwd>/.rivet/chaos/chaos.db`（SQLite，WAL）。库跟着会话的工作目录走，不是进程启动目录——同一进程里的不同工作区各有一个库。

表：`event`（真相，只追加）、`claim`（双时态视图）、`assembly_log`、`schema_migrations`。

---

## 验证

```bash
node --test tests/*.test.js                    # 83 个单元测试
node scripts/verify-all.js                     # 六项系统验证，零外部依赖
node scripts/unspoken-bench.js                 # unspoken 规则版：训练集 / 留出集
DEEPSEEK_API_KEY=... node scripts/unspoken-bench.js --llm   # unspoken LLM 版
DEEPSEEK_API_KEY=... node scripts/e2e.js       # 真实模型端到端（花费 token）
```

---

## License

Apache-2.0 © Chaos contributors
