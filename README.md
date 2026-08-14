# DSH 拖拽文件转路径插件（Drop File to Path）— 持久化版

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 提供 **Codex 式拖拽交互**：拖入任意文件 → 分块上传到本机 `~/.dsh-dropbox` → 路径以**蓝色整体 chip** 插入输入框光标处（Hermes 风格）。

本仓库是**持久化 profile 插件**（`dsh.bundle` + `dsh.client` 双声明）：按官方方式安装一次，**DSH 重启后自动生效**，不再依赖动态插件重建。

## 功能特性

- 🖱️ 页面任意位置拖入任意文件（含多文件、含图片）
- 📍 **本机文件直接引用原路径**：Chromium（Edge/Chrome）拖拽会经 entry API 暴露源文件路径——直接插入原路径，**不再复制文件、不再产生 `_1/_2` 重名副本**；仅当浏览器拿不到路径（如 Firefox）时才回退到 dropbox 上传
- ♻️ **同名同大小自动复用**：回退上传时宿主端检测到 dropbox 已有完全相同文件则直接返回旧路径，不再重复落盘（序号不再增长）
- 🔵 路径以**一个整体 chip** 插入：整段蓝色文字（**只显示文件名+格式**）、不可被局部删改（Backspace/Delete 一次删除整个路径）
- 📐 **篮筐宽度随文件名自适应**：插入时用 composer 真实字体实测文件名宽度，pill 精确贴合（误差 <1 个字符），不再有固定宽度空槽
- 🙈 **`.b64` 后缀与 `_1/_2` 重名序号显示隐藏**：落盘时的插件痕迹永不显示——提交给 agent、复制、持久化的仍是带后缀的真实路径
- 📌 光标处插入（已有会话）；新会话创建页拖入后创建会话时自动插入
- 📄 智能落盘：文本类（.md/.csv/.a2l/.s19/.ini/.cnf/.prm/.txt/.yml/.json/.xml/.log/.cfg/.bat/.sh/.py/.js/.ts/.html/.css）**解码写原文**；二进制存 `.b64`（base64），agent 一行 Python 解码读取
- 🚀 4MB 分块上传，上限 512MB；失败右下角红色提示 4 秒
- 🧹 捕获阶段接管拖拽事件，官方"仅支持图片"附件通道完全静默

## `.b64` 是什么？

浏览器无法保证任意二进制文件的原始字节能无损地穿越 JSON/文本通道，所以**回退上传**的二进制文件（PDF、3MF、ZIP、图片等）落盘时以 **base64 文本**保存，文件名追加 `.b64` 作为标记——agent 看到 `.b64` 就知道要先解码再使用：

```python
import base64
with open('xxx.pdf.b64') as f: raw = base64.b64decode(f.read())
with open('xxx.pdf', 'wb') as f: f.write(raw)
```

文本类文件（.md/.txt/.json 等）直接写原文，**不会**带 `.b64`。**本机文件走原路径引用时不经过 dropbox，天然没有 `.b64`**。输入框里的路径始终隐藏 `.b64`（如果存在），但实际提交/复制的路径包含它，agent 能正确读取文件。

## 为什么本机文件还要"存一份"？（旧行为）

浏览器拖进来的 `File` 对象是内存数据，**不暴露磁盘路径**（浏览器安全限制），而 agent 只能读磁盘路径——所以插件需要把文件物化到 dropbox，agent 才能访问。现在 Chromium 拖拽经 `DataTransferItem.webkitGetAsEntry()` 能拿到源路径（Windows 形如 `/C:/Users/...`），本机文件直接引用即可，不再复制；拿不到路径的场景（Firefox、非本机来源的拖拽）才走 dropbox 上传兜底。

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
| Client 半（`lib/client.js`） | 浏览器（`__ModuleLoader__` bundle，`dsh.client` 声明） | 全局拖拽监听（capture 接管）、fetch 分块上传、注册 trigger source、经 `conversation.input.insertReference` 插入参考 chip |

路径 chip 走 composer 原生的参考引用机制（U+FFFC 占位符 + occurrence 表 + 提交时 codec 序列化）：占位符在草稿里只占一个字符，因此整条路径是一个不可分割的整体；提交时经插件注册的 `drop-file-to-path` source 的 codec 把占位符展开为真实路径（含 `.b64`）。

**篮筐宽度自适应**：插件在插入前用 composer 的真实字体实测 label 宽度，算出 NBSP 空格数 `pad`，随 chip 一起插入（占位符 + pad 个 NBSP）。chip 单元格宽度 = 基础 1em + pad×空格宽 ≈ 文件名宽——**先有文件名，后有篮筐**。为此本插件做了两处配套：

- **加宽字体**：用 `tools/patch-chip-font.mjs` 把 `DshChipCell` 的 U+FFFC advance 从 composer 默认 4em 改为 **1em**（同名字体族、后声明者生效，textarea/镜像/背板三层共享同一 advance，对齐关系不变）；
- **核心 composer 扩展**（`dsh-client-ui-conversation`）：occurrence 支持 `pad` 扩展占位区间——插入、序列化、复制/剪切投影、Backspace/Delete 整删、backdrop 渲染全部按 `[offset, offset+1+pad)` 整段处理（改动随该包 bundle 分发，无 pad 的旧 chip 行为不变）。

依赖官方服务：`webServer`（HTTP 路由）、`slots`（shell.overlay + conversation.composer.dock）、`inputTriggers`（source 注册与序列化）、`conversation`/`sessions`（按 session 解析输入门面）。除上述核心 occurrence 扩展外不修改 dsh 源码。

## 文件说明

```
├── lib/index.js            # Host 半：HTTP 上传路由 + node:fs 落盘
├── lib/client.js           # Client 半：全局拖拽 + chip 插入（含加宽字体内嵌）
├── tools/patch-chip-font.mjs  # 生成加宽 DshChipCell 字体的工具（改宽度后重跑）
├── chip-cell-font.b64      # 加宽字体产物（client.js 内嵌同一份）
├── cordis.patch.yml        # bundle 补丁层（insert 插件行）
├── package.json            # dsh.bundle.patch + dsh.client 声明
└── README.md
```

## 落盘与读取约定

- 落盘目录：`C:\Users\<用户>\.dsh-dropbox\`（`os.homedir()` 解析）
- `.b64` 解码（agent 侧）：见上文 `.b64` 说明

## License

MIT
