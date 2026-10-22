# 踩过的坑与验证方法

这里是必须记住的坑：每条都真实发生过，症状和排查路径都写下来了。新会话不需要从头读，遇到相关问题再查。

## npm 发布与插件升级

**`npm publish` 报 404 ≠ 包不存在。** npm 用 404 隐藏「你没有权限」：token 失效时同样返回
`E404 ... The requested resource '@zmairc/persona-forge@<版本>' could not be found or you do not have permission`。
先 `npm whoami`；报 `ENEEDAUTH`/`401` 就重新登录：

```powershell
npm login --registry=https://registry.npmjs.org/
```

用户级 `.npmrc` 的默认源是 `registry.npmmirror.com`（只读镜像，登不进去），所以 `--registry` 一定要带。

**怎么区分「发布成功但 CDN 没刷出来」和「发布根本没成功」**：

```powershell
npm view @zmairc/persona-forge versions --json
```

列表里有这个版本号 = 只是缓存延迟，等几分钟；没有 = 那次发布没成功。

**升级插件不能用 `update`。** `dsh plugin add <包>@<版本>` 会往 profile 的 `package.json` 写**精确版本**，`pnpm update` 在精确范围里找不到更新的版本，所以原地不动。每次升级都要：

```powershell
dsh plugin --profile web add @zmairc/persona-forge@<新版本>
```

装完确认：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@zmairc\persona-forge\package.json" -Pattern '"version"'
```

（`Select-String` 必须写 `-Path` / `-Pattern`，只给位置参数会把路径当正则，报 `Unrecognized escape sequence \U`。）

**`EADDRINUSE :3080`** 说明旧的 `dsh web` 还占着端口：先关旧实例（`netstat -ano | findstr :3080` 拿 PID），再从项目目录启动新的。

## 关键约束（容易踩）

**网络**：DSH 沙箱拦截对外 API。`chat` / `distill` / `eval` 的真实调用**必须在用户自己的 PowerShell 窗口里跑**，agent 这边跑必然 401（伪错误）。`stats` / `parse` / `distill --dry-run` / 测试都是离线的，agent 可以直接跑。

**分块现状（已实测）**：两条人设的 `data/*.jsonl` 都是 562 条消息，切成 11 块（每块 22–60 条，约 276–1142 字），默认 `--max-chunks 12` 刚好能覆盖全部。记录里的说话人是微信昵称（`dennis` / `^O^`），现在草稿默认取 `persona.md` 的标题（吴文哲/赵明）做显示名，`--friend` 可覆盖。

**大规模文本**：`forge` 默认处理全部块，`--sample N` 用 `sampleEvenly` 在全部对话上均匀抽 N 块（不是取前 N 块，那会只剩一个月份）。3 万条消息约 500 块，全量就是 500 次调用；抽 40 块能覆盖所有时间段，成本降一个数量级。代价是低频特征可能漏掉。短语统计已改成"均匀采样 + 计数回填"，不会在 30 万短语处截断。

## forge 首次真跑（demo，样例 553 条）

`forge --file transcript.sample.txt --persona demo --me "^O^"` → 解析 553 条（^O^ 165 / dennis 332），10/10 块成功，写出 `personas/demo/persona.md`。结构正确：统计块、带原话的特征、`avoid`、口头禅带全库次数、多轮连发样本、覆盖 10/10。

生成结果暴露三个问题（已修）：
1. **称呼混进骂人的话**：`你这他妈`、`你` 被当成称呼 → `isAddressTerm` 过滤脏话词和裸代词。
2. **`avoid` 出现「不写长段解释」**：和「不写长句」同一个毛病 → `LENGTH_BAN` 正则直接丢弃所有"不长句/不长段"式规则。
3. **标题用微信昵称**：`# dennis`。新增 `--display`（forge/MCP 都有），开源用户可指定真名。

另外 `刚` 加进口头禅黑名单（用户之前裁定它不是口头禅）。

**重跑验证通过**：`--display 吴文哲` 后标题是 `# 吴文哲`，称呼只剩 `老弟` `赵明`，`avoid` 里不再有「不写长段解释」，口头禅里 `刚` 已被剔除。

**用户正在另开对话做「一键导出微信聊天记录」的小工具**，做完后会用导出的 txt 回来实测 `forge`。导出格式最好是 `昵称` 换行 `时间戳` 换行 `内容`（微信多选复制的 header-pair 布局，`parse.ts` 第一个就试这种）。

## 真实导出实测（2026-10，吴文哲 8188 条，2024-09 ~ 2026-10）

导出路径 `E:\zmairc\wxoutput\导出\吴文哲_20261019_2217\chat.txt`（同目录还有 chat.html 和 media/）。

**新布局 `bracket`**：日期分隔 `---------- 2024-09-25 ----------` + `[22:32:24] 吴文哲:` + 下一行缩进正文。已加进 `parse.ts` 并排第一优先。解析 8165/8188 条（差的 23 条是空消息），吴文哲 4835 / 我 3330。

统计（`stats --file`）：平均 10 字（剔除 18 条千字长文）、中位 5、90 分位 15、8 字以内 75%、1–2 字 19%、连发 3.2 条/组、问号字符 1.0%、表情 `[捂脸]126 [呲牙]123`。和手写版的 7 字/5 字/18%/4.0 同量级，数据更全后数字更稳。

**长文保护**：最长一条 12914 字（4793 条里 38 条 >200 字、18 条 >1000 字）。`renderChunk` 现在单条截断到 300 字并注明 `（共 N 字）`，否则一条长文就能撑爆一段 context。统计均值排除千字长文，否则"平均 26 字"会误导。

分块规模：训练 7348 条 → 146 块，全量 146 次调用；`--sample 40` 抽 40 块。

**全量实测（146/146 块，零失败零重试）**：特征质量最高，已到可直接进人设的程度——「被问问题，先说在忙 ← `一会哈，我做完这个实验报告`」「讲完题，用短问确认 ← `懂了不`」「喊人不应就一直呼叫 ← `呼叫呼叫`」「约事只发短句不解释 ← `中午洗澡去不`」。

全量也放大了两个合并短板（已修）：
1. **口头禅又混进功能词**：`可` `得` `给我` `明天` `收到转账`。黑名单扩充，并加 `SYSTEM_WORDS` 过滤转账/红包/语音等系统词。实测 16 条 → 7 条：`赵明(125) 行(122) 咋(49) 噢(48) 额(39) 走(35) 嗯(31)`。
2. **近义规则各占一条**：`不道歉` / `不主动道歉`。包含去重抓不到插词，改用 Levenshtein 相似度（阈值 0.6）去重，traits / avoid / 口头禅 / 立场 / 幽默统一走 `dedupeBySimilarity`。

**全量还暴露了第三个问题（已修）**：146 块合并后每条特征的 `count` 基本都是 1，排序退化成"按文本最短取"，前 8 条变成「用连发短消息接着说」这种泛泛短句，还不如 40 块版。修法：
- 排序改为 `count` 相同则按 evidence 长度降序（有具体原话的优先）。
- 新增 `consolidateObservations`（reduce 阶段）：trait 数超过 20 时，**多调一次模型**把 730 条分段观察归纳成 8 条，要求每条能照着演、evidence 只能从原文摘。失败自动回退到未归纳结果，不影响产出。

**最终全量实测（146/146，reduce 711 条 → 8 条）**：特征回到了可执行的粒度——
- `被问成绩只报数字，不解释 ← 81分`
- `发消息拆成多条短句连发 ← 赵明 你能不能去 京东 给我取快递 现在`
- `问复习方法就分步骤列清单 ← 看一章ppt然后看这章的习题…`
- `突然叫对方全名，紧接着追问具体题号 ← 赵明 你看看 上次现代…`
- `拒绝帮忙就说不会，让人去看网课 ← 我不会就是不会，我自己都是看网课学的`

最后修的两个渲染问题：
- 口头禅里混进 32 次的微信系统消息（`如需收钱，请点此升级至最新版本`）→ 口头禅长度上限 6 字。
- 一条 evidence 是整段抖音口令 → evidence 超 60 字截断加 `…`。

这两处只改渲染层，所以**没有重跑**，直接就地修补了当前 `personas/wuwenzhe/persona.md`。结论：`forge` 主路径（txt → 人设）定稿。

## MCP 插件挂进 DSH（A1 完成）

DSH 自带 `@deepseek-ai/dsh-mcp-client`，但默认没启用。挂载方式：

1. `~/.dsh/profiles/web/cordis.patch.yml` 加：

```yaml
- insert:
    - id: persona-forge-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: personaforge
        command: 'C:\Program Files\nodejs\node.exe'
        args: ['E:\zmairc\persona-forge\src\mcp\server.ts']
        cwd: 'E:\zmairc\persona-forge'
        toolCallTimeoutMs: 600000
        failOnStartupError: false
```

2. 工具名变成 `mcp__personaforge__forge_persona` 和 `mcp__personaforge__chat_persona`。

3. **key 走项目根的 `.env`**（`.gitignore` 已覆盖）。MCP server 是 DSH 启动的子进程，继承不到用户 PowerShell 窗口里的环境变量，必须读文件。`llmConfigFromEnv()` 现在每次调用都重读 `.env`，父进程留下的空值也会被覆盖。

**踩过的坑**：改完配置后 `patchReload: live` 没有替换掉旧的 MCP 进程，必须**重启 dsh web** 才生效。重启后会话历史保留。

验证结果：`chat_persona` 用 `personas/demo`（阿凯）回了一句「行」——单字、无标点，符合人设。

## DSH 插件化（准备发布到 DSH Plugin Hub）

MCP 是外部协议，用户想发到 DSH 插件中心，所以改走原生插件：

- 包名 `persona-forge`，入口 `src/dsh/plugin.ts`（cordis 插件：导出 `name` / `inject: ['tools']` / `apply(ctx)`，用 `defineTool` 注册两个工具，`ctx.tools.register(...)`）。
- `cordis.patch.yml` 声明 bundle patch，`package.json` 加 `dsh.bundle.patch`、`keywords: [dsh, dsh-plugin, ...]`、peerDependency `@deepseek-ai/dsh-tools`。
- 本地测试：`dsh plugin --profile web add link:E:\zmairc\persona-forge`（会改 profile 的 package.json，需要 danger-full-access）。
- **发布到 DSH Plugin Hub（dsh-plugin.org）的条件**：GitHub 公开仓库 + 仓库 topic 加 `dsh-plugin` + README 含安装命令 + 导出 `apply(ctx)`。自动扫描收录，初始 `unconfirmed`，人工核实后 `verified`。提交页 dsh-plugin.org/zh/submit。
- 未做：npm 发布（需要 npm 账号）、GitHub 仓库、LICENSE。
- **key 仍走 `.env`**：插件由 DSH 进程加载，读不到用户 shell 的环境变量。

### 发布形态：必须发编译后的 `dist/`

**Node 拒绝在 `node_modules` 里剥离 TypeScript**（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。源码入口 `src/dsh/plugin.ts` 只能本地跑，装进 profile 就崩。所以：

- `scripts/build.ts` 把 `src/**/*.ts` 剥离类型、改写导入为 `.js`，写到 `dist/`（20 个文件）。
- `package.json` 的 `main` / `exports` / `bin` 全部指向 `dist/*.js`，`files` 只发 `dist` 不发 `src`。
- `prepublishOnly` 在发布前重新构建，所以 `dist/` 不必入库（`.gitignore` 已忽略）。

**验证方式（每次发版都做）**：`npm pack` 到 `.tmp-pkgtest/`，解包后把 `package/` 复制到 `.tmp-runtime/node_modules/@zmairc/persona-forge`，再 `node` 里 `import('@zmairc/persona-forge')` 并调用 `apply(ctx)`。DSH 解析 `@deepseek-ai/dsh-tools` 靠的是 `$DSH_HOME/profiles/node_modules`（安装依赖闭包，junction 指到 dsh 安装目录），所以把该目录 junction 到 `node_modules/@deepseek-ai` 就能离线模拟，不需要真装。

**这个验证有个陷阱（踩过一次）**：脚本放在仓库里时，Node 会走**包自引用**，`import('@zmairc/persona-forge')` 直接命中仓库自己的 `dist/`，根本没碰 `node_modules`——看起来通过，其实什么都没验证。修法：在 `.tmp-runtime/` 里放一个 `{"name":"pf-verify","type":"module"}` 的 `package.json`，把这个目录变成独立的包作用域，bare import 才会真的落到 `node_modules`。脚本里必须断言 `import.meta.resolve(...)` 的路径包含 `/node_modules/@zmairc/persona-forge/`。
（沙箱不允许在系统临时目录建 `node_modules`，所以别把验证目录放到仓库外。）

### 人设写在会话工作目录，既不写 `node_modules` 也不依赖进程 cwd

`archive.ts` 的根目录不能简单取"模块往上两级"：源码里命中仓库根没问题，但装成包之后那两级落在 `node_modules/@zmairc/persona-forge/`，`personas/`、`data/`、`.env` 全会写进包里，下次 `pnpm` 更新直接清掉。

第一版修法（0.1.3/0.1.4）是 `resolveRoot(env, moduleDir, cwd)`：`PERSONAFORGE_ROOT` 优先；路径里出现 `node_modules` 就用 `process.cwd()`。**这个假设是错的**——DSH 的会话工作目录和 `dsh` 进程的 cwd 是两回事。用户从项目目录起 `dsh web` 才会碰对；若 DSH 是从别处启动的（快捷方式、其它终端、GUI），插件就去错误目录找 `.env`，`chat_persona` 报「缺少 API key」，看起来像没配置 key，实际是路径错了。这个坑真踩过。

0.1.5 的正确做法：`archive.ts` 导出 `rootDir()` / `setRoot(dir)`；插件在每次 `execute(args, exec)` 里先 `retargetToSession(exec)`，从 `exec.agent.session.header.cwd` 取**会话工作目录**再 `setRoot`。这也是 DSH 自己文件工具用的锚点（`dsh-tool-fs`：`const cwd = exec.agent?.session.header.cwd`）。`loadDotEnv()` 的默认路径改成每次调用时 `join(rootDir(), '.env')`，所以重定向根目录会同时重定向 `.env` 查找。

优先级：`PERSONAFORGE_ROOT` > 会话工作目录（插件）/ 模块目录（CLI、MCP、测试）。单测在 `tests/root.test.ts`（含 `setRoot` 往返）。**插件侧不要再在 `apply()` 里读 `.env`**——那时还不知道会话目录。

### 0.1.2 发废了：不要在本机测试包里 `npm install` 打包文件

**症状**：`dsh plugin --profile web add @zmairc/persona-forge@0.1.2` 报
`Failed to resolve dependency: Could not install from "C:\Users\lenovo\.dsh\profiles\web\zmairc-persona-forge-0.1.2.tgz" as it does not exist.`

**根因**：`package.json` 里留了一条自依赖 —— `"dependencies": {"@zmairc/persona-forge": "file:zmairc-persona-forge-0.1.2.tgz"}`。它是之前用 `npm install ./xxx.tgz` 在本项目里试装打出来的包时被 npm 写进去的，然后跟着一起提交、一起发布了。pnpm 在 profile 目录装包时照着这条去 profile 目录找那个 tgz，找不到就整体失败。0.1.1 也带自依赖（`^0.1.0`），只是恰好能解析到 registry，所以没报错。

**排查路径**（下次直接照抄）：读 registry 元数据的 `dependencies` 字段，而不是盯着 pnpm 的报错猜
→ `https://registry.npmjs.org/@zmairc/persona-forge`。**pnpm 的报错位置指向哪里，就往那个包自己的 manifest 里找那条路径从哪来。**

**防复发**：`tests/package.test.ts` 六项守护 —— 不许自依赖、不许 `file:`/`link:`/`.tgz` 依赖、`main`/`exports`/`bin` 必须是 `dist/*.js`、`files` 必须含 `dist` 且不含 `src`、`dsh.bundle.patch` 必须存在、版本号是 semver。

**教训**：本机试装打包产物要在**项目目录之外**的临时目录做（如 `.tmp-pkgtest/`），永远别在项目根 `npm install <tarball>`——它会改你自己的 `package.json` 并跟着发布出去。

**API key**：`$env:PERSONAFORGE_API_KEY` 或项目根的 `.env`。`HKCU\Environment` 里那份历史 key 已删除（2026-10-20，原长度 35）。`start-chat.ps1` 已无明文。

**安全**：`personas/*/transcript.txt` 和 `data/` 含真实聊天记录，`.gitignore` 已覆盖。要开源必须脱敏。

