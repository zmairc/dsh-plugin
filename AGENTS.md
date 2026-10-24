# persona-forge

从聊天记录里蒸馏一个人的说话风格，做成可移植的人设，让任何 AI 扮演他。

**这是交接说明。** 新会话先读这一页就够开工；细节在 `docs/` 里，按需去查，不要一开始全读。

## 文档索引

| 文件 | 什么时候读 |
|---|---|
| `docs/decisions.md` | 蒸馏和盲测怎么迭代的、哪些结论已被数据验证、两个人设的核心统计 |
| `docs/pitfalls.md` | 踩过的坑：发布形态、路径解析、批量导入的脏数据，每条都有症状和排查路径 |
| `docs/retro-2026-10-21-zhaoming.md` | 赵明全量蒸馏的 20 条复盘，工具改进的主要来源 |
| `README.md` | 对外文档：装法、命令、隐私边界 |

## 现状（更新于 dennis/zhaoming 两个人设完成时）

零依赖、零构建，Node 24 原生跑 TypeScript。**不需要 `npm install`**。

```
node src/cli/index.ts <命令>
```

| 模块 | 状态 | 位置 |
|---|---|---|
| 宽松解析器（3 种布局 + 兜底） | ✅ 完成 | `src/core/parse.ts` |
| 统计指纹 | ✅ 完成 | `src/core/stats.ts` |
| 人设三层（persona / lore / style） | ✅ 完成 | `src/core/persona.ts` |
| 对话 REPL（含 `/actions` 开关） | ✅ 完成 | `src/cli/chat.ts` |
| 自动蒸馏 `distill` | ✅ 定稿：结构、说话人标签、口头禅过滤、负向规则去重都过了真实数据验证 | `src/core/distill.ts` |
| 一键流水线 `forge` | ✅ 代码完成：txt → persona.md，支持任意规模 + 抽样控成本 | `src/core/forge.ts` |
| 盲测 `eval` | ⚠️ 两轮修正后改成混排判断题（10 真 + 10 假），**需重跑才算数** | `src/cli/eval.ts` |
| 两版对比 `compare` / `duel` | ✅ 新增（2026-10-22）：`compare` 比统计分布（零标注），`duel` 做成对比较（题源逻辑抽到 `core/evalkit.ts`） | `src/cli/compare.ts`、`src/cli/duel.ts`、`src/core/evalkit.ts`、`src/core/compare.ts` |
| MCP server | ✅ 可用，已挂进 DSH（两个工具：`forge_persona` / `chat_persona`） | `src/mcp/server.ts` |
| 启动器 | ✅ 可用 | `启动对话.cmd` |
| 微信/QQ/抖音 导入器 | ❌ 未做，靠手动粘贴 | — |
| QQ 机器人 | ❌ 未做 | — |
| 记忆检索（FTS5） | ❌ 未做 | — |

测试：`node --test --test-isolation=none "tests/*.test.ts"`（152 项全绿）

## 关键约束（容易踩）

**网络**：DSH 沙箱拦截对外 API。`chat` / `distill` / `eval` 的真实调用**必须在用户自己的 PowerShell 窗口里跑**，agent 这边跑必然 401（伪错误）。`stats` / `parse` / `distill --dry-run` / 测试都是离线的，agent 可以直接跑。

**分块现状（已实测）**：两条人设的 `data/*.jsonl` 都是 562 条消息，切成 11 块（每块 22–60 条，约 276–1142 字），默认 `--max-chunks 12` 刚好能覆盖全部。记录里的说话人是微信昵称（`dennis` / `^O^`），现在草稿默认取 `persona.md` 的标题（吴文哲/赵明）做显示名，`--friend` 可覆盖。

**大规模文本**：`forge` 默认处理全部块，`--sample N` 用 `sampleEvenly` 在全部对话上均匀抽 N 块（不是取前 N 块，那会只剩一个月份）。3 万条消息约 500 块，全量就是 500 次调用；抽 40 块能覆盖所有时间段，成本降一个数量级。代价是低频特征可能漏掉。短语统计已改成"均匀采样 + 计数回填"，不会在 30 万短语处截断。

## 开源准备进度（2026-10）

- ✅ **HKCU 里的历史 key 已删除**（`HKCU\Environment\PERSONAFORGE_API_KEY`，原长度 35）。沙箱默认拒绝写注册表，需要 `danger-full-access` 才能删。`start-chat.ps1` 早已无明文。
- ✅ **公开示例**：`examples/public/`，含合成 118 条对话（`transcript.txt`）、示例人设（`persona.md`）、统计指纹（`style.md`）、说明（`README.md`）。不含任何真人数据，已确认不被 `.gitignore` 忽略。
- ✅ **README** 补了「先看一个例子」「一条命令生成人设」「作为 MCP 插件」三节。
- ✅ 首次提交完成（`2d24437`），LICENSE 已加（MIT）。
- ✅ **GitHub 仓库**：https://github.com/zmairc/dsh-plugin（原 persona-forge，用户改名后同步；最新 commit `730548e`）
- ✅ **npm 包**：`@zmairc/persona-forge` 已上线 `0.1.3` → `0.1.6`（2026-10-22）
  - 原想用 `persona-forge`，npm 以「与已有包 `personaforge` 太相似」拒绝，改用 scoped 包
  - npm 账号 `zmairc` 已开 2FA（npm 强制：发布必须 2FA）
  - 版本线：`0.1.0`/`0.1.1` 入口指向 `src/*.ts` → 装进 profile 必崩；`0.1.2` 带自依赖 → pnpm 装不上；`0.1.3` 第一个能装能加载；`0.1.4` 与 0.1.3 同内容，只为绕开 staged publish 占号；`0.1.5` 会话工作目录修正；`0.1.6` 按复盘改进
  - 发布相关的坑（staged 占号、token 失效报 404、`update` 升不上去）都在 `docs/pitfalls.md`
- ✅ **插件在 DSH 里跑通并升到 0.1.6**：`forge_persona` 结果末尾打印 `persona-forge 0.1.6 · ROOT <会话目录>`，三份旧文件覆盖前都会存 `.prev`
- ⬜ **发布 0.1.7**（B2/B4/B7 这一批）：`npm publish` 之后要用 `dsh plugin --profile web add @zmairc/persona-forge@0.1.7`，**`update` 无效**

## 用户的长期愿景（2026-10-20 原话整理）

1. **DSH 插件中心**：用 DSH 的人都能装，把自己的语气/性格传给 AI。
2. **GitHub 通用版**：让 Claude 等其他客户端也能用（MCP server 已经具备这个能力，和 DSH 插件共用同一套核心）。
3. **接入聊天软件**：等 DSH 接入 QQ / 微信 / 抖音 / B站 之后，这些 AI 能聊天、答题、看视频、玩游戏。
4. **最后一步**：这些 AI 都装上性格插件，有专属性格。

这个愿景决定了架构取向：核心（parse / stats / distill / forge / persona）必须和传输层解耦。现在已经是这样——CLI、MCP server、DSH 插件都只是薄壳，未来加 QQ adapter 不用动核心。

## 下一步

### 先做完的小事

1. **发布 0.1.7**：这批攒了 B2/B4/B7 + `compare`/`duel` + `--recent`/`--as` + 说话规矩 + 关系层 + 长句平衡 + `export` + 证据校验。

   **用脚本，别手敲**——npm token 几小时就失效，手敲会漏掉重新登录、然后得到一个误导性的 404：
   ```powershell
   .\scripts\publish.ps1
   ```
   脚本依次做：工作树检查 → `git push` → `npm login` → `npm publish` → 查版本 → 打印装插件命令。

2. **装进 DSH**（脚本最后会打印）：
   ```powershell
   dsh plugin --profile web add @zmairc/persona-forge@0.1.7
   ```
   `update` 升不上去（add 写的是精确版本），见 `docs/pitfalls.md`。

### 已经验证过的，别再重做

- **时效性（`--recent`）被证伪**：最近 6 个月版 `zhaoming6` 的 compare 距离 0.137，比全量版 0.089 更差；eval 准确率 67%。**数据少，模型反而更极端**（「压过头」第三次）。→ 用全量版 `zhaoming`，弃用 `zhaoming6`。
- **短句已过关，中长句是短板**：盲测漏掉的 5 条 AI 全是 `行` / `去` / `行，你吃啥` / `去哪` / `行，我在门口`；唯一误伤的真人是一句中长句 `几分钟的事，不是还早吗`。dennis 两轮（70%/75%）同一模式。
- **微信记录 = 微信版的他**：长句、长文结构、面对面的语气都不在数据里。这是数据源的结构性上限，不是代码能补的。用户自己的例子：「跟你对话我喜欢长对话、喜欢鼓励，这些微信里一条都没有」。

### 已完成（2026-10-22 第二批）

1. **说话规矩** ✅ 从统计直接生成的长度与标点规则，渲染在 `persona.md` 最前面（`fbfb91f`）；长句锚点取真实原话（`d6a2f91`）；措辞按 longShare 分档，碎片型说话的人不会被要求写长（`c423b9c`）。
2. **关系层 / 事实层** ✅ `lore.md` 三节约定（关系 / 事实清单 / 禁区）+ 事实边界注入 + forge 结尾引导模板（`e55bd14`）。自由格式 lore 保持兼容。
3. **长句平衡** ✅ 会话级按比例补长句，不再指望 prompt（`0226a3d`）。`chat` 维护最近回复长度，落后于统计比例时才要求一条长的；碎片型（<15%）不启用。
4. **导出标准角色卡** ✅ `export --persona <名字>` 生成 SillyTavern V2 卡片到 `data/`（`0575332`、`941afd9`）。14 字段齐全，`first_mes` 取真实原话，`description` 按官方建议分节（说话规矩 / 行为模式 / 他从不做什么 / 语言习惯 / 共同经历 / 禁区）。

**子代理调研的价值**：查 character-card-spec-v2 和 SillyTavern 文档时，子代理抓到我的致命遗漏——`first_mes` 是模型学长度和标点的入口（官方原话），我原本留空了。这类"只读资料、不写文件"的调研任务适合交出去，不与其他改动冲突。

### 接着做

1. **C：大五人格评估**（用户指定下一步）：把 `compare` 的统计距离换成或补上人格维度，让「像不像」有可复现的指标。
2. **多源输入架构**（大，真正的上限突破）：现在一切都假设「一份 txt 的聊天记录」。语音转写、长文（日记/笔记）、多个聊天对象——三样各自能打开一个现在完全关着的房间。这是动架构，不是加功能。

### 明确不做

- **时效性**：已证伪，见上。
- **去 GitHub 找 persona 插件改造**：那些是手写 prompt 模板，我们的资产是蒸馏，抄实现等于退回手写。只值得抄 SillyTavern 的 `scenario`（情境）字段思路。

### 更远的（暂缓）

合并 dennis 旧草稿、补 `personas/dennis/lore.md` 的待补充清单、QQ 机器人（OneBot 11 + NapCat）、记忆检索（FTS5）、公开示例试跑。

## 和用户的协作方式

用户就是赵明本人（`personas/zhaoming` 的原型），反馈非常精确——会直接标注「这一句不像」并说明理由。**照标注改，不要自己发挥。**

他关心的事：人设要像、功能要能开源给别人用、别往 C 盘乱写文件。

用户给的真实数据比任何推测都可靠。他补充一句真实原话，胜过十条我编的规则。


