# 赵明全量蒸馏：工具与流程复盘（2026-10-21）

本次任务：用 `E:\zmairc\wxoutput\导出\吴文哲_20261019_2217\chat.txt`（8188 条，解析 8165）蒸馏赵明，替换手写版。
执行方式：DSH 插件 `forge_persona`（profile 里装的是 npm 上的 `@zmairc/persona-forge` 0.1.x 的 `dist/`），**不是仓库源码**。

下面每条都带本次的具体现象和可执行的改法，按优先级分四组。

---

## A. 会导致错误结果或数据风险

### A1 插件跑的是 npm 包，仓库改动不生效

现象：改完 `src/core/parse.ts` 后 `forge_persona` 行为没变——profile 里加载的是 0.1.3/0.1.4 的 `dist/`。最后只能绕：把临时 txt 里的 media 行手工换成 `[图片]`。

改法（任选其一或都做）：
- 开发期用 `dsh plugin --profile web add link:E:\zmairc\persona-forge`，改完 `npm run build` 再重启；
- 两个工具在结果末尾打印 `package.json` 的 `version` 和 `ROOT`，一眼看出跑的是哪份代码；
- README 写清「改源码 → build → publish → 更新插件」这条链路，别让人以为改完就生效。

涉及：`src/dsh/plugin.ts`、`package.json`、`README.md`

### A2 蒸馏「记录主人自己」要绕一大圈

现象：`--me` 是记录主人。要蒸馏赵明（导出里叫「我」），得 `--me 吴文哲 --friend 赵明`，但渲染出来的对话全是 `我：…`，模型容易把两人看反。本次靠手工把 3330 行 `[时间] 我:` 改成 `[时间] 赵明:`。

改法：加 `--target self`（或 `--as-self`），渲染时把 self 的标签换成 `--display` 给的名字。`verifySamples` 按 role 校验，改名不影响。

涉及：`src/core/forge.ts`、`src/core/distill.ts`（`renderChunk` 的 `selfName` 传参）

### A3 导出媒体的两种写法都没被识别

现象一（已修）：`media/00001_xxx.jpg`、`视频：media/…`、`附件：x.docx -> media/…` 共 407 条被当成 text，短语统计变成 `00(132) me(117) ia(116) medi(115)`。已在 `parse.ts` 新增 `MEDIA_LINE` + `mediaPathKind`，加 3 个单测，97 项全绿。**受 A1 影响，要发版才生效。**

现象二（未修）：`&lt;mediatagname /&gt;` 这类 HTML 残留（贴的代码）会进文本统计，噪声小可忽略。

改法：发 0.1.6 带上 parse 修复；`stats` 明细里补一行媒体消息条数，方便核对。

### A4 附件行带真实姓名和学号，redact 打不到

现象：导出正文里有 `附件：2024xxxxxx-姓名.docx -> media/…` 这类行，学号+真名都在。这些已进 `personas/zhaoming/transcript.txt` 和 `data/zhaoming*.jsonl`（都在 `.gitignore` 里），但用户要开源或分享人设时是真实泄露点。

改法：`redact.ts` 加「连续 12 位数字（学号/工号）」和「姓名+学号」组合规则；现在 `--redact` 只打码手机号、身份证、邮箱、链接。

涉及：`src/core/redact.ts`、`src/core/forge.ts:113`

### A5 forge 只备份 persona.md，style.md / transcript.txt 直接覆盖

现象：本次是手工 `Copy-Item` 整个目录到 `personas/zhaoming.manual/` 才保住手写版。`forge.ts:160-162` 只把旧 `persona.md` 存成 `persona.prev.md`，`style.md`（833 字节）和 `transcript.txt` 会被无声覆盖。

改法：三份都留 `.prev`，或者覆盖前打印「将覆盖 persona.md / style.md / transcript.txt（旧文件已备份到 …）」。

涉及：`src/core/forge.ts:120-162`

---

## B. 会浪费时间的坑

### B1 试跑会覆盖正式产物

现象：先跑 `--sample 3` 测速，它直接把 `personas/zhaoming/persona.md` 覆盖成 3 块的薄版本。此时如果有人调 `chat_persona`，拿到的是差人设。

改法：已有 `persona.md` 且传了 `--sample` 时，默认写 `persona.sample.md`；或者加 `--dry-run`（调模型但不落盘）。

涉及：`src/core/forge.ts:131-162`

### B2 大跑没有进度，也不知道花了多少

现象：142 块，插件里 `onProgress: () => {}` 全丢了（`plugin.ts:64`），调用返回前看不到任何进度；返回后只有「处理 142 块」。耗时、token、成本都没有。

改法：
- 插件把进度写到 `data/<persona>.progress.log`（每块一行），外部可轮询；
- `complete()` 记 `usage`，forge 汇总输出「142 次调用，输入 X / 输出 Y token」。

涉及：`src/dsh/plugin.ts:64`、`src/core/llm.ts`、`src/core/forge.ts`

### B3 大规模 forge 的耗时和超时行为没写进文档

现象：为了确认 142 块会不会被工具超时切断，现去翻 `dsh-tool-call-timeout-policy` 的 README，才知道「工具没声明 `timeoutMs` 就不会被切」。这条结论提前写进 README 能省十几分钟。

改法：README 补一段「大规模 forge 的耗时与超时行为」。

涉及：`README.md`

### B4 两套「口头禅」口径不一致

现象：`style.md` 里 `口头禅（相对你明显更常用）：不是(89)、知道(88)` 只有 2 条；`persona.md` 里「口头禅」16 条，含 `来(158) 行(118) 好(111) 打(102)` 这类单字虚词，还有 `签到(26)` 这种只在某段时间集中的话题词。

改法：`annotateCatchphrases` 复用 stats 的过滤（单字虚词、连接词、话题词），或者两个字段改名区分开：`高频短语` / `口头禅`。

涉及：`src/core/distill.ts:156`、`src/core/stats.ts:172`

### B5 统计口径在两版之间不可比

现象：手写版逗号 40%，全量版 24%；平均长度 15.9 → 17；中位 9 → 7。不是数据变差：分母变了（全量含大量单字消息），而且 `stats` 算的是「含该标点的文字消息条数占比」，手写版大概是按字符算的。

改法：`renderStyleBlock` 明确写「占文字消息条数的比例」；覆写旧 `style.md` 时打印新旧对比（`平均长度 15.9 → 17`、`逗号 40% → 24%`），一眼看出是数据更全还是代码出错。

涉及：`src/core/stats.ts:297`

### B6 「你」的指代在一份人设里不统一

现象：统计块的 `你 4397 条` 里「你」= 记录主人（吴文哲）；正文和 `ROLEPLAY` 里的「你」= 被扮演者。本次手工统一成名字（`吴文哲 4397 条`）。

改法：`renderStyleBlock` 默认用名字而不是「你」；或 README 写死约定。

涉及：`src/core/forge.ts:123`、`src/core/persona.ts:56`

### B7 模型观察和统计打架，只能人工抓

现象：`avoid` 写「不追问对方细节」，和手写版「爱追问」冲突（有原话 `回学校干啥呀`）；幽默里写「用感叹号夸张抱怨」，但统计里感叹号几乎为 0。本次人工删了这两条。

改法：加 `lintPersona()`——从统计里取实际比例，凡是 avoid/humor 出现「不写长句 / 不用问号 / 不用感叹号 / 不写括号」但统计显示确有使用，就在草稿末尾打警告。`LENGTH_BAN` 已经是这个思路，扩展成通用冲突检测即可。

涉及：`src/core/distill.ts`（渲染阶段）

### B8 samples 里混着媒体占位

现象：真实对话里出现 `他：[sticker]`、`你：[语音 2"]`，读起来怪，还占篇幅。

改法：渲染 samples 时把媒体消息换成一句描述，或直接跳过。

涉及：`src/core/distill.ts:757`

### B9 evidence 里塞了代码

现象：`被要代码就贴完整整段` 这条的 evidence 是 `#include<stdio.h> …`，作为人设提示没意义。

改法：evidence 命中 `#include`、`{}`、`;`、`->` 时降权，换成更口语的另一条。

涉及：`src/core/distill.ts`（evidence 选择）

---

## C. 交接文档与验证

### C1 AGENTS.md 太长（400+ 行）

新会话要整篇读，成本高；而且「现状」里的测试数已过时（写 95，实际 97）。

改法：拆成 `docs/pitfalls.md` / `docs/decisions.md`，`AGENTS.md` 只留索引和当前状态。

涉及：`AGENTS.md`

### C2 导出预处理没有脚本

现象：这次手工做了三步——说话人改名、媒体行换占位、检查学号，全靠一次性 PowerShell，脚本没入库，只在 AGENTS.md 写了自然语言步骤。

改法：加 `node src/cli/index.ts prepare --file <原始导出> --self 我 --as 赵明`，一条命令产出干净中间 txt（顺带做 A2 的改名和 A4 的打码）。

涉及：新增 `src/cli/prepare.ts`（或 `src/core/prepare.ts`）

### C3 缺一个「新旧人设谁更像」的验证

现象：现在没法客观说全量版比手写版像。`data/zhaoming.holdout.jsonl` 有 817 条，`eval` 是现成的。

改法：下一步分别用 `zhaoming`（全量）和 `zhaoming.manual`（手写）出题，混排让用户标注，比较准确率。注意两版 persona.md 的措辞不同，`findLeaked` 要按各自文件算。

涉及：`src/cli/eval.ts`

---

## D. 给下一个 agent 的环境提示

- 插件工具跑在 DSH 进程里，**能联网**；`pwsh` 沙箱不能（`Invoke-WebRequest https://api.deepseek.com` 直接断连）。所以 `forge` / `chat` 只能在插件工具里跑，自己起 CLI 必然失败。
- 读 `data/*.jsonl` 用 `node -e` 或 read 工具，别用 `Get-Content | ConvertFrom-Json`——Windows PowerShell 按 GBK 读 UTF-8，中文全乱报错。
- 确认插件解析到哪个 ROOT，别去查进程 cwd（`Get-CimInstance` 在本沙箱被拒），看报错信息或用 `PERSONAFORGE_ROOT`。
- 本次的临时清洗文件已删，清洗后的全文留在 `personas/zhaoming/transcript.txt`（649 KB）。重跑 forge 可以直接用它，注意里面 `[图片]` 已是占位、「我」已改成「赵明」。
- 手写版备份在 `personas/zhaoming.manual/`（persona.md / style.md / transcript.txt），别覆盖它。
