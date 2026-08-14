# DSH 拖拽文件转路径插件（Drop File to Path）

为 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）Web GUI 提供 **Codex 式拖拽交互**：把任意文件（PDF、图片、文档、固件……）拖进页面，文件自动上传到本机接收目录，**路径文本直接插入输入框光标处**——就像 Codex / Hermes 桌面端一样，无需上传附件、无需复制粘贴路径。

## 功能特性

- 🖱️ **拖拽即用**：页面任意位置拖入任意文件（含多文件、含图片）
- 📌 **路径直达输入框**：上传完成后路径自动插入输入框光标处（已有会话）；新会话创建页（hero）拖入后，创建会话时自动插入
- 📄 **智能落盘**：文本类（.md/.csv/.a2l/.s19/.ini/.cnf/.prm/.txt/.yml/.json/.xml/.log/.cfg/.bat/.sh/.py/.js/.ts/.html/.css）原样保存；二进制（.pdf/.xlsx/.stp/.pptx/.jpg 等）存为 `.b64`（base64）编码文件，agent 收到后用 Python 一行解码即可读取
- 🚀 **大文件分块**：4MB/块分块上传，上限 512MB（足以拖入数百 MB 的维修手册）
- 🔢 **重名保护**：同名文件自动追加 `_1/_2/_3` 序号
- 🧹 **无干扰**：在捕获阶段接管拖拽事件，官方"仅支持图片"附件通道完全静默，不弹任何错误提示
- ⏱️ **错误提示**：上传失败右下角红色提示，4 秒自动消失

## 工作原理

DSH 浏览器端无法像 Electron 桌面应用那样直接读取拖拽文件的本地原始路径（浏览器安全模型），因此本插件实现等效闭环：

```
拖拽 File → 浏览器分块读取(FileReader) → host.call RPC → Host 端 fs 服务落盘
→ 返回绝对路径 → inputActions.setDraft 插入输入框（光标处） → agent 按路径读取
```

架构（双 Slot + 双半）：

| 部件 | 挂载位置 | 职责 |
|---|---|---|
| Host 半（`host.js`） | 宿主进程 | `drop-upload/begin\|chunk\|end\|abort` 四个 RPC：分块接收、校验、落盘到 `~/.dsh-dropbox/` |
| Client `ShellDrop` | `shell.overlay`（root 范围） | document 捕获阶段监听 dragenter/dragover/drop，全页面生效（含新会话创建页）；"文件已就绪"卡片兜底 |
| Client `DockInserter` | `conversation.composer.dock`（session 范围） | 挂载时立即尝试 + 订阅事件，用官方 `inputActions.setDraft` 把路径插入输入框 |

关键细节：
- 拖拽事件用 `capture: true` + `stopPropagation()` 完全接管，官方图片附件通道（DropOverlay）收不到事件，不会弹出"不支持该格式 仅支持图片"之类的提示
- 插入位置：输入框聚焦时光标处；用户在上传期间编辑过则插到末尾；多文件按行插入
- 落盘目录：`<workspaceRoot>/.dsh-dropbox/`（DSH 的 sandboxPolicy.workspaceRoot）

## 安装 / 重建（DSH 动态插件）

DSH 动态 Cordis 插件在进程重启后丢失，重建步骤如下（任何会话均可，建议在"创造模式"会话）：

1. 读取本仓库 `host.js` 与 `client.js` 源码
2. 调用 `cordis_define`：
   - `plugin: { kind: "new", idPrefix: "drop" }`
   - `code.host`: `host.js` 内容；`code.client`: `client.js` 内容
3. 用 `cordis_run` 激活（Client 包需在界面批准一次）

也可以在会话中直接说"重建拖拽插件"，agent 会从本仓库或预设归档自动执行上述步骤。

## 文件说明

```
├── host.js        # Host 半：分块上传接收 + 落盘 RPC
├── client.js      # Client 半：全局拖拽监听 + 输入框路径插入
├── README.md
└── LICENSE
```

## 落盘与读取约定

- 落盘目录：`C:\Users\<用户>\.dsh-dropbox\`（Windows）
- `.b64` 文件解码（agent 侧，Python）：

```python
import base64
with open('xxx.pdf.b64') as f: raw = base64.b64decode(f.read())
with open('xxx.pdf', 'wb') as f: f.write(raw)
```

## License

MIT
