# persona-forge

把聊天记录蒸馏成可扮演的人设，让 AI 用他的方式说话。

这是一个给 [DeepSeek Harness](https://deepseek-harness.github.io/) 用的插件。装完之后，在 DSH 里给它一个导出的聊天记录 txt，它自动解析说话人、统计风格、逐块蒸馏，产出可以直接用的人设；之后还能用这个人设跟你对话。

> **和「角色卡改写」类插件不同**：你不需要手写人设。给一份聊天记录导出文件，它自己读、自己统计、自己蒸馏出这个人说话的方式。

零依赖、零构建，Node 24 直接跑 TypeScript。

## 安装

```bash
dsh plugin --profile web add @zmairc/persona-forge
```

装完 DSH 里多出两个工具：

| 工具 | 作用 |
|---|---|
| `forge_persona` | 给一个 txt 路径，自动生成人设 |
| `chat_persona` | 给一个人设名和一句话，按那个人的口吻回复 |

需要 Node 24+，以及一个 OpenAI 兼容的模型端点（默认 DeepSeek）。key 放在项目根目录的 `.env`：

```
PERSONAFORGE_API_KEY=sk-...
```

本地开发、或者改了代码想立刻试，用 `link:` 装当前目录：

```bash
dsh plugin --profile web add link:E:\code\persona-forge
```

## 隐私

- 解析、统计、蒸馏全部在本地跑，聊天记录不会上传到本项目
- 只有切块后的对话片段会发给你自己配置的模型端点
- `data/`、`personas/*/transcript.txt`、`.env` 都在 `.gitignore` 里，不会进仓库
- 把生成的人设分享给别人之前，先跑 `ingest --redact` 把手机号、身份证、邮箱、链接打掉

几乎所有人第一反应是"拿聊天记录训一个模型"。别做：

## 为什么不是微调

几乎所有人第一反应是"拿聊天记录训一个模型"。别做：

| 问题 | 说明 |
| --- | --- |
| 数据量不够 | 单一对象的 LoRA 要有明显风格迁移，至少 5k–10k 条高质量对话；数据少时学到的是"平均语气"，不是"他对我说的话" |
| 不可发布 | 每个用户都要训一个模型，显存和时间劝退绝大多数人；prompt 方案是拷一个文件就能换人 |
| 不可编辑 | "他太爱用句号了"这种反馈，微调要重训，改一行 prompt 就行 |
| 毁能力 | 小数据微调会显著削弱模型的推理和指令跟随 |

本项目走 **离线蒸馏 + 运行时 prompt 分层注入**。真正难的是蒸馏质量，不是注入。

## 先看一个例子

`examples/public/` 里有一份**合成的**聊天记录（118 条）和它对应的人设，不含任何真人数据：

- 不跑任何命令，直接读 `examples/public/persona.md`，就知道产物长什么样
- 想跑通流程：

```bash
node src/cli/index.ts forge --file examples/public/transcript.txt --persona demo --me 我 --display 阿凯
```

## 一条命令生成人设

把导出的聊天记录存成一个 txt（格式随便，微信/QQ 的复制粘贴都能认），然后：

```bash
node src/cli/index.ts forge --file 聊天记录.txt --persona 老王 --me 我
```

它会自动解析说话人、算风格指纹、把对话切块让模型读、写出 `personas/老王/persona.md`。中间不用你操作。

文本很多时加 `--sample 40`：从全部对话里均匀抽 40 块，覆盖不同时间段但控制花费；不加就是全量。

## 作为 DSH 插件

```bash
dsh plugin --profile web add @zmairc/persona-forge
```

装完 DSH 里多出两个工具：

| 工具 | 作用 |
|---|---|
| `forge_persona` | 给一个 txt 路径，自动生成人设 |
| `chat_persona` | 给一个人设名和一句话，按那个人的口吻回复 |

本地开发时用 `link:` 装当前目录：

```bash
dsh plugin --profile web add link:E:\code\persona-forge
```

两种方式都需要项目根目录的 `.env` 提供 key——插件由 DSH 进程启动，读不到你 shell 里的环境变量。

## 作为 MCP 插件

```bash
node src/mcp/server.ts
```

起一个 MCP stdio server，只暴露一个工具 `forge_persona`。客户端把 txt 路径传进来，它跑完整条流水线，返回人设路径和摘要。

Claude Desktop 的 `claude_desktop_config.json` 示例：

```json
{
  "mcpServers": {
    "persona-forge": {
      "command": "node",
      "args": ["E:\\code\\persona-forge\\src\\mcp\\server.ts"],
      "env": { "PERSONAFORGE_API_KEY": "sk-..." }
    }
  }
}
```

`forge_persona` 参数：`file`（必填，txt 绝对路径）、`persona`（必填，目录名）、`me`、`friend`、`source`、`chunkSize`、`sample`、`sampleHoldout`、`redact`。

## 快速开始（手动模式）

想一步步控制，或者看看中间产物，用下面的流程：

```bash
# 1. 看一眼工具能干什么（用内置的合成样例）
node src/cli/index.ts stats --file personas/example/transcript.sample.txt

# 2. 把你的记录粘进 personas/<名字>/transcript.txt，然后解析
node src/cli/index.ts ingest --file personas/example/transcript.sample.txt --persona demo --me 我

# 3. 再跑一次统计，输出可以粘进 persona.md 的风格指纹
node src/cli/index.ts stats --persona demo --markdown

# 4. 编辑 personas/demo/persona.md，然后开始聊
node src/cli/index.ts chat --persona demo
```

`chat` 需要一个 OpenAI 兼容接口：

```bash
export PERSONAFORGE_API_KEY=sk-...            # 没设则回退 DEEPSEEK_API_KEY
export PERSONAFORGE_BASE_URL=https://api.deepseek.com/v1   # 默认值
export PERSONAFORGE_MODEL=deepseek-chat                     # 默认值
```

PowerShell 用 `$env:PERSONAFORGE_API_KEY = "sk-..."`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `ingest --file <txt> --persona <name>` | 解析粘贴的原始记录为 `data/<name>.jsonl` |
| `speakers --file <txt>` | 只列出识别到的说话人，用来确认 `--me` 填谁 |
| `stats --persona <name>` | 统计风格指纹 |
| `stats --file <txt>` | 直接对原始文本统计，不落盘 |
| `distill --persona <name>` | 让模型读对话，生成 `persona.draft.md` 初稿 |
| `chat --persona <name>` | 进入扮演对话 |
| `eval --persona <name> --n 10` | 出 2n 条回复（一半真人原话、一半 AI 编的），让你挑出 AI 编的 |
| `reveal --persona <name>` | 对盲测答案 |

`distill` 参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `--chunk <n>` | `60` | 每次模型调用读多少条消息 |
| `--max-chunks <n>` | `12` | 最多调用几次，控制花费 |
| `--friend <名字>` | `persona.md` 的标题 | 草稿里怎么称呼他；记录里的微信昵称只在提示词里用 |
| `--dry-run` | 关 | 只打印分块和字符数，不调模型、不写文件 |
| `--overwrite` | 关 | 直接覆盖 `persona.md`，默认只写 `persona.draft.md` |

先用 `--dry-run` 看一眼分块和编号对不对，再去掉它正式跑。想先试 prompt 效果又不想花钱，就加 `--max-chunks 3` 只读前三块。

自动生成的是**初稿**：统计部分精确；`他的特征` 每条带一句原话，方便核对；`他从不做什么` 是负向规则，最容易编，逐条删。样例保留连发的多轮原话，不是单问单答。

`ingest` 参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `--me <名字,...>` | 自动 | 哪一边是你。**强烈建议显式指定** |
| `--friend <名字>` | 出现最多的一方 | 哪一边是要模仿的朋友 |
| `--holdout <0-1>` | `0.1` | 留出多少比例不参与人设构建，只用于评测 |
| `--source <name>` | `manual` | 记录来源标记，写进消息元数据 |

## 怎么准备第一批 200 条

不要手打，也不要随机挑。目标是**覆盖多种情境**，因为人格需要各种情绪状态下的样本：

| 情境 | 为什么需要 |
| --- | --- |
| 日常寒暄、找话题 | 决定他闲聊时的默认语域 |
| 情绪低落、被安慰 | 决定他示弱时的表达方式 |
| 吵架、别扭、冷战 | 决定他的冲突模式，这是最容易露馅的地方 |
| 分享链接/视频/歌 | 决定他"安利"东西的语气 |
| 求助、给建议 | 决定他说理时的句式和长度 |
| 久别重逢、生日节日 | 决定他的热络程度 |
| 深夜长聊 | 决定他放松状态的句子长度和话题 |

采集方式见 `docs/how-to-collect.md`。最快的路线是先用微信 PC 端多选复制，粘成一个 txt 就够跑通全流程；导出工具（chatlog / qq-chat-exporter）等到要处理十万条以上再上。

粘的时候格式随便，`ingest` 会尝试三种布局并在报告里告诉你它认成了哪种。认错了就把 `speakers` 的输出发出来，加一种布局很快。

## 产物

```
personas/<name>/
  ├── persona.md         # 手写人设，进 system prompt，决定"像不像"的 70%
  ├── transcript.txt     # 你粘进来的原文
  └── style.md           # stats 生成的风格指纹
data/
  ├── <name>.jsonl       # 归一化后的消息
  └── <name>.holdout.jsonl
```

`data/` 不入库。原始记录任何情况下不上传、不外发。

## 路线图

- [x] 统一消息模型 + 宽松粘贴解析
- [x] 统计风格指纹
- [x] 单人格 chat（prompt 注入）
- [x] 留出集盲测
- [x] LLM 蒸馏流水线（分块观察 + 合并 + 生成 `persona.draft.md`）
- [x] MCP server（`forge_persona` / `chat_persona`）
- [x] DSH 原生插件（`dsh plugin add @zmairc/persona-forge`）
- [ ] 微信 chatlog / QQ qq-chat-exporter / 抖音 importer
- [ ] 记忆检索（SQLite FTS5）
- [ ] OpenAI 兼容 API 层
- [ ] QQ 机器人（OneBot 11 + NapCat）

## 伦理边界

这个项目让你自己复刻一段关系，不是让你冒充一个人。

- 全本地运行，记录不外传
- 生成的说话人应被标记为 AI 模拟，不要拿去骗共同好友
- 不提供、也不接受"接入对方真实账号"或"主动给对方发消息"的能力
- 分享 persona pack 前跑一遍 `ingest --redact`，把真实姓名、电话、地址打掉
