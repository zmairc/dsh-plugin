# 公开示例

这里是一份**合成**的聊天记录，人物和对话都是编的，不涉及任何真人数据。它用来演示 persona-forge 从「一个 txt」到「一份人设」的过程，也给 fork 的人一个能直接跑通的起点。

| 文件 | 说明 |
|---|---|
| `transcript.txt` | 合成聊天记录，格式和微信导出工具一致（日期分隔 + `[时分秒] 名字:` + 缩进正文） |
| `persona.md` | 示例人设，展示产物长什么样。这份是手工整理过的，不是自动生成的 |
| `style.md` | `stats` 自动统计出来的风格指纹 |

## 不跑命令也能看

直接读 `persona.md`。真正的 `forge` 产出结构类似，区别是：

- 统计部分是自动算的，一定准确
- 「他的特征」每条带一句原话，但可能不准，需要你核对
- 「他从不做什么」是负向规则，最容易编，逐条删

## 跑通流程

```bash
node src/cli/index.ts forge --file examples/public/transcript.txt --persona demo --me 我 --display 阿凯
```

需要 `PERSONAFORGE_API_KEY`。118 条对话切成 3 块，三次调用，几十秒。

产物写到 `personas/demo/`，和这里的 `persona.md` 对比一下，能看出自动蒸馏和你手工整理差在哪。

## 自己造一份

把自己的聊天记录导成一个 txt，格式随意——`parse.ts` 会自动识别四种布局，跑 `speakers --file <txt>` 可以先看认得对不对：

```bash
node src/cli/index.ts speakers --file 我的聊天.txt
```

认出说话人之后再跑 `forge`。
