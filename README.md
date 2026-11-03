# Chaos

人机恋记忆内核。**DeepSeek Harness 插件**（Cordis 契约，`dsh-plugin`），Apache-2.0 许可。

它解决的不是「存下来」，是「在对的时候想起来」——所以她会主动提起那个还没兑现的承诺，也会在自己记不清时开口核对，而不是信誓旦旦地说错。

数据流只有一条：

```
对话原文
  ↓ 触发    session/event（user/message）——自动，不靠模型主动调工具
  ↓ 抽取    规则（基线，零成本） / LLM（deepseek-flash，三道门校验）
  ↓ 写入    闸门 → 引文门 → 值支撑门 → 合并代数 → 双时态
  ↓ 存储    event（真相，只追加） + claim（派生视图）
  ↓ 装配    BM25 + 势能 Φ，按 query 有无明确指向切换两种模式
  ↓ 注入    system-prompt/assemble 自动拼入 <chaos> 块，硬预算 200 字符
```

---

## 状态

| 项 | 结果 | 依据 |
|---|---|---|
| **dsh 插件契约** | **16/16 通过**（`name`/`inject`/`apply` + 4 工具注册 + 端到端 + 自动写入/注入 + 宿主 LLM + 库路径） | `tests/plugin.test.js` |
| 库路径 | 按会话 `header.cwd` 分库，不同 cwd 互不可见 | `tests/plugin.test.js` K16 |
| 宿主装配 | `chaos` 与 `llm` / `dsh-session` 同在 web profile 配置树 | `dsh --profile web --dump-config` |
| 单元测试 | **72 / 72 通过** | `node --test tests/*.test.js` |
| 规模入库 | 240,500 条 / **437 ms** | `scripts/verify-all.js` |
| 检索延迟 | P50 **0.28 ms** / P95 **0.49 ms** | 200 次 assemble |
| 注入预算 | 最大 200 字符，超限 **0/10** | budget=200 |
| 势能涌现 | 闲聊查询下**承诺排首位** | `verify-all.js` §4 |
| 装配确定性 | 同输入三次**完全一致** | `verify-all.js` §5 |
| 双时态 | 改口后旧值 `tx_to` 正确关闭 | 杭州→成都 等 3 条 |
| 规则抽取 | 18/18 条事实 | `scripts/ingest.js` |
| LLM 抽取（真实调用） | 18 次 **0 失败**，格式遵守 **100%** | `scripts/e2e.js` |
| 端到端召回 | **8/8**（7 个第 1 位） | `scripts/e2e.js` |
| 宿主真实加载 | **模块已激活**（修掉依赖版本错配后，`dsh --profile web` 启动无 `did not activate` 警告） | `dsh-start3.log` |
| **工具在 UI 里可见** | **未验证** | 需在真实会话调用一次 `chaos_status` |
| **LLM 全量成本** | **未测算** | 18 次 114 秒，线性外推 24 万条 ≈ 25 小时 |

---

## 快速开始

### 装进 dsh

```bash
# 1) 从 npm 装进目标 profile（web / desktop 按需替换）
dsh plugin --profile web add dsh-chaos-memory

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

### 调用工具

```js
// 1) 写入：source_text 是本轮原文，quote 必须是它的子串
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
```

记忆不再靠模型「想起来」：插件在 `session/event` 的每条用户消息上自动抽取写入，在 `system-prompt/assemble` 时自动把该浮现的记忆拼进上下文（query 传空 → 涌现模式）。`chaos_recall` 保留为模型主动检索的入口，但不再是记忆进入上下文的唯一路径。

### 接 LLM 抽取器（密钥不进插件）

```js
import { extractLLM } from './src/extract-llm.js'

const cands = await extractLLM(text, {
  slots: ['user.pet.name', 'user.job', /* ... */],
  callModel: async (prompt) => {
    // 这里才是你放 key 和 SDK 的地方
    const r = await client.chat.completions.create({ model: 'deepseek-flash', messages: [...] })
    return r.choices[0].message.content
  },
})
```

`callModel` 由宿主注入，插件不 import 任何模型 SDK、不读环境变量、不发网络请求。

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

实测 3,000 样本对抗：合法 750/750 通过，伪造引文 / 错值 / 瞎编槽位 **各 0/750 放行**。

模型输出里还有第二类项：`{"kind":"unspoken","quote":"..."}`——只回答「这段话里有没有想说却没说出口」。这一项**不接受模型给的槽位和值**：槽位由原文哈希派生（`unspoken.<hash>`，与规则版同址，同一句话不会落成两条主张），值就是原文整句。模型只能决定「判不判」，不能决定「写什么」，所以它胡编也污染不了库。规则版 `UNSPOKEN_RE` 保留为零成本兜底。

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

**最高 R ≥ 0.2 → 检索模式**（按 R 排序）；**否则 → 涌现模式**（按 Φ 排序）。

实测：问「今天好累」→ 首位是「三月十七那天我一整晚都陪着你，说好了」。

---

## 关键取舍

**真相是事件，不是记忆。** `event` 只追加、存原文；`claim` 是可重建的派生视图。代价是存储翻倍，换来任何一条记忆都能回溯到原话、库坏了能重放重建、抽错能撤回而不污染历史。

**不上向量库。** 单用户记忆量在几百条量级，BM25（中文单字 + bigram + IDF）够用，零依赖、可解释、不会因嵌入服务挂掉而失效。

**不确定时沉默。** 同槽位矛盾且无法裁决 → `deferred`，不进注入。宁可少提一句，不提错一句。

**模型是外部输入，不多给一分信任。** 它抽出的每一条都要过三道门；即使它完全胡编，也污染不了记忆库。

**闸门只在入口做一次。** 所有校验都在 `ingestClaim` 这一个边界上，内部函数信任结果。

**批量写入必须包事务。** 24 万条裸写要 **266 秒**（每条 fsync），包 `BEGIN/COMMIT` 后 **437 ms**——608 倍差异。这个缺陷在 `:memory:` 上永远看不见。

---

## 文件结构

```
chaos/
  index.js            dsh 插件入口：Cordis apply(ctx) + 4 个 tool
  cordis.patch.yml    bundle patch：把 chaos 行 insert 进 profile 配置树
  package.json        dsh.bundle.patch 指向上面这个文件；依赖版本须与宿主一致
  src/
    constants.js      阈值常量（唯一来源）
    db.js             SQLite schema：event / claim / assembly_log + 迁移
    gate.js           写入闸门：体积 / 编码 / 凭据
    store.js          双时态存储：引文门 + 值支撑门 + 合并代数 + 四态
    retrieval.js      BM25（中文单字 + bigram + IDF）
    potential.js      线程派生 + Φ + 双模式装配
    fidelity.js       衰减 / 背离 / 协商话术 / 改口链
    extract.js        规则抽取器（模式表，零成本基线）
    extract-llm.js    LLM 抽取器（三道门校验模型输出；含 unspoken 判断项）
  tests/              71 个用例，8 个文件
  scripts/
    ingest.js         真实对话灌入 + 统计
    llm-probe.js      真实模型抽取探针（空返回率 / 召回 / 误抽）
    e2e.js            端到端：抽取 → 入库 → 自然问句召回
    verify-all.js     六项系统验证（性能 / 预算 / 涌现 / 确定性 / 双时态）
```

---

## 数据

`<cwd>/.rivet/chaos/chaos.db`（SQLite，WAL）

表：`event`（真相，只追加）、`claim`（双时态视图）、`assembly_log`、`schema_migrations`。

---

## 验证

```bash
node --test tests/*.test.js          # 71 个单元测试
node scripts/verify-all.js           # 六项系统验证，零外部依赖
DEEPSEEK_API_KEY=... node scripts/e2e.js   # 真实模型端到端（花费 token）
```

---

## 未做

- **自动通道已接宿主 LLM**：`session/event` 上规则版同步先写（兜底），随后异步调 `ctx.llm`（宿主的 key，插件自己不读环境变量、不存密钥）补齐语义项。路由取自 `session.requestHeader().config`；会话首次请求前没有路由，那一轮只用规则版。失败只降级到规则版结果，不影响会话。代价是每轮一次模型调用 + `inject` 多了 `llm`（无 LLM 服务的 profile 不会加载本插件）。**真实宿主下的模型调用未实测**——单测用假 `ctx.llm` 验证接线，本机没有可用的宿主凭据。
- **真实 dsh 会话的事件流未观测**：装配面已验证（`dsh --profile web --dump-config` 里 `chaos` 与 `llm`、`dsh-session` 同在配置树，`inject` 可满足），事件契约取自宿主成品源码（`dsh-session-title`、`dsh-working-directory`），接线由假 ctx 单测覆盖；还缺一次真实会话的 `session/event` 观测（需要可用的模型凭据，本机没有）。
- **unspoken 的规则版泛化能力**：规则版在留出集上召回 **0/10**（训练集 12/12，但那是照着正则写的）——它能认出固定句式，换一种说法就失效。语义判断已交给 LLM 抽取器的 `unspoken` 项，规则版只作零成本兜底。基准：`node scripts/unspoken-bench.js`（规则版）/ `DEEPSEEK_API_KEY=... node scripts/unspoken-bench.js --llm`（LLM 版）。**LLM 版在真实模型上的留出集成绩未测**——本地无密钥，目前只验证了管线：理想判断输入下留出集 10/10 不被门禁误杀。

---

## License

Apache-2.0 © Chaos contributors
