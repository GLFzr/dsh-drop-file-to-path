# DSH 拖拽文件转路径插件（Drop File to Path）— 持久化版

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 提供 **Codex 式拖拽交互**：拖入任意文件 → 分块上传到本机 `~/.dsh-dropbox` → **路径文本自动插入输入框光标处**。

本仓库是**持久化 profile 插件**（`dsh.bundle` + `dsh.client` 双声明）：按官方方式安装一次，**DSH 重启后自动生效**，不再依赖动态插件重建。

## 功能特性

- 🖱️ 页面任意位置拖入任意文件（含多文件、含图片）
- 📌 路径自动插入输入框光标处（已有会话）；新会话创建页拖入后创建会话时自动插入
- 📄 智能落盘：文本类（.md/.csv/.a2l/.s19/.ini/.cnf/.prm/.txt/.yml/.json/.xml/.log/.cfg/.bat/.sh/.py/.js/.ts/.html/.css）**解码写原文**；二进制存 `.b64`（base64），agent 一行 Python 解码读取
- 🚀 4MB 分块上传，上限 512MB；重名自动 `_1/_2` 序号；失败右下角红色提示 4 秒
- 🧹 捕获阶段接管拖拽事件，官方"仅支持图片"附件通道完全静默

## 安装（官方方式，一次永久）

```sh
# 在 deepseek-harness 仓库根目录（源码版）：
pnpm dsh plugin --profile web add ./plugins/drop-file-to-path

# 或任意 dsh 安装（npx 版亦可）：
dsh plugin --profile web add <本仓库路径>
```

`dsh plugin` 会 pnpm link 本包到 `$DSH_HOME/profiles/web` 并追加 `dsh.profile.bundles`。之后**无论用 npx 版还是源码版启动 DSH，插件都自动加载**。

验证：`dsh web --dump-config` 应出现 `# == dsh-drop-file-to-path` 层。

## 工作原理

| 部件 | 位置 | 职责 |
|---|---|---|
| Host 半（`lib/index.js`） | 宿主进程，`inject: ['webServer']` | HTTP 路由 `/api/drop-file-to-path/begin|chunk|end|abort`，node:fs 直写落盘 |
| Client 半（`lib/client.js`） | 浏览器（`__ModuleLoader__` bundle，`dsh.client` 声明） | 全局拖拽监听（capture 接管）、fetch 分块上传、`inputActions.setDraft` 插入路径 |

依赖官方服务：`webServer`（HTTP 路由）、`slots`（shell.overlay + conversation.composer.dock）、`inputActions`/`useInput`（composer dock standard props）。不修改任何 dsh 源码。

## 文件说明

```
├── lib/index.js        # Host 半：HTTP 上传路由 + node:fs 落盘
├── lib/client.js       # Client 半：全局拖拽 + 路径插入输入框
├── cordis.patch.yml    # bundle 补丁层（insert 插件行）
├── package.json        # dsh.bundle.patch + dsh.client 声明
└── README.md
```

## 落盘与读取约定

- 落盘目录：`C:\Users\<用户>\.dsh-dropbox\`（`os.homedir()` 解析）
- `.b64` 解码（agent 侧）：

```python
import base64
with open('xxx.pdf.b64') as f: raw = base64.b64decode(f.read())
with open('xxx.pdf', 'wb') as f: f.write(raw)
```

## License

MIT
