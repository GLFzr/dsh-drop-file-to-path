# DSH 拖拽文件转路径插件（Drop File to Path）v1.4.8

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 提供 **Codex 式拖拽交互**：拖入任意文件 → 分块上传到本机 `~/.dsh-dropbox` → 路径以**蓝色整体 chip** 插入输入框光标处（Hermes 风格）。

本仓库是**持久化 profile 插件**（`dsh.bundle` + `dsh.client` 双声明）：按官方方式安装一次，**DSH 重启后自动生效**。

## 功能特性

- 🖱️ **页面任意位置拖入任意文件**（多文件、图片均可）；拖拽时全屏提示"松开以接收文件"
- 📍 **本机文件直接引用原路径**：Chromium（Edge/Chrome）拖拽会经 entry API 暴露源文件路径——直接插入原路径，**零上传、零复制**（你电脑里那份文件就是唯一的一份）；仅当浏览器拿不到路径（如 Firefox）时才回退到 dropbox 上传
- ♻️ **两级去重（先查后传）**：`begin` 先按名字+大小查 dropbox，命中**秒回**旧路径（不上传——重复拖同一大文件立即出结果）；首次上传时 `end` 对完整内容算 sha256 与候选逐字节比对——同名同大小但内容不同绝不误复用，落 `_1` 副本
- 🔵 路径以**一个整体 chip** 插入：整段蓝色文字（**只显示文件名+格式**）、不可被局部删改（Backspace/Delete 一次删除整个路径）
- 📐 **篮筐宽度随文件名自适应**：插入时用 composer 真实字体实测文件名宽度，pill 精确贴合（误差 <1 个字符），不再有固定宽度空槽
- 🙈 **`.b64` 后缀与 `_1/_2` 重名序号显示隐藏**：落盘时的插件痕迹永不显示——提交给 agent、复制、持久化的仍是带后缀的真实路径
- 📌 光标处插入（已有会话）；新会话创建页拖入后创建会话时自动插入
- 📄 智能落盘：文本类（.md/.csv/.a2l/.s19/.ini/.cnf/.prm/.txt/.yml/.json/.xml/.log/.cfg/.bat/.sh/.py/.js/.ts/.html/.css）**解码写原文**；二进制存 `.b64`（base64），agent 一行 Python 解码读取
- 🛡️ **完整性校验**：每块精确长度校验、分块必须齐全、解码后字节数必须与声明一致——截断/缺块/伪造数据一律拒绝，绝不落盘损坏文件
- ⏳ **插入点待机圆环**：上传真正需要等待时，在文件将要插入的位置（光标右侧一个字符处）显示 DeepSeek 蓝色转圈环（渐隐拖尾、持续转动）；**瞬间完成的路径（本机直引、秒回去重、极小文件）不出圈**；chip 插入的同一瞬间圆环立即消失，绝不拖延
- 🚀 ~4MB 分块上传，上限 512MB；请求体上限 16MB/次；失败右下角红色提示 4 秒
- 🧹 捕获阶段接管拖拽事件，官方"仅支持图片"附件通道完全静默
- 🗑️ **侧边栏垃圾桶图标（设置图标上方）**：一键打开 Dropbox 清理浮层——列出全部落盘文件（名称/大小/时间/冗余标记），一键清理**冗余 `_N` 副本**、**按大小阈值清理**或**清空全部**——操作前展示将删除数量与释放空间并二次确认，避免 dropbox 无限膨胀

## 为什么必须上传到 Dropbox？（浏览器限制）

这是 **WebUI 与 Hermes/Codex 之类本地 CLI 的本质区别**，不是本插件的缺陷：

- **浏览器是沙盒**：网页里的 JavaScript **拿不到本地文件的磁盘路径**（安全模型，防止网页偷读你的磁盘）。Hermes/Codex 直接跑在你的电脑上，可以随便读 `C:\...\xxx.pdf`；DSH 的 Web GUI 是一个浏览器网页，**它手里的文件只是一个内存 `File` 对象**。
- **agent 只能读磁盘路径**：agent 读取文件靠的是磁盘路径。浏览器无法把一个内存文件"变成"磁盘路径交给 agent，所以插件必须先把文件**物化到本机 `~/.dsh-dropbox`**，agent 才能访问。
- **唯一的例外（不需要上传）**：Chromium 系浏览器（Edge/Chrome）拖拽**本机文件**时，`DataTransferItem.webkitGetAsEntry()` 能探测到源文件路径——此时插件**直接引用原路径，零上传、零复制**。Firefox、或从非本机来源（网页、压缩包内）拖拽时拿不到路径，才必须走上传兜底。
- **大文件的代价**：新文件第一次拖入必须完整上传（几百 MB 也要传），这是浏览器限制决定的。为了把重复成本降到零，插件做了两级去重（见工作原理）。

## Dropbox 清理

dropbox 是插件的"中转站"，会随着使用积累文件（尤其大文件）。**侧边栏底部、设置图标上方的垃圾桶图标**（悬停显示"清理 Dropbox"提示）打开清理浮层：

- **文件清单**：名称、大小、修改时间；`_N` 后缀的**冗余副本**自动标注（旧版本去重失效留下的残骸，v1.2.3 起不会再新增——除非同名文件内容真的变了）
- **清理冗余副本**：一键删除所有 `_N` 副本（推荐——你的电脑里已有原文件，这些副本是纯浪费）
- **按大小清理**：输入阈值（MB），删除大于该值的文件
- **清空全部**：删除 dropbox 里所有文件（高危，二次确认）
- 任何操作前都会显示"将删除 N 个文件、释放 X"，并提示**历史会话引用的路径会失效**——清理前请确认没有正在使用的会话

## `.b64` 是什么？

浏览器无法保证任意二进制文件的原始字节能无损地穿越 JSON/文本通道，所以**回退上传**的二进制文件（PDF、3MF、ZIP、图片等）落盘时以 **base64 文本**保存，文件名追加 `.b64` 作为标记——agent 看到 `.b64` 就知道要先解码再使用：

```python
import base64
with open('xxx.pdf.b64') as f: raw = base64.b64decode(f.read())
with open('xxx.pdf', 'wb') as f: f.write(raw)
```

文本类文件（.md/.txt/.json 等）直接写原文，**不会**带 `.b64`。**本机文件走原路径引用时不经过 dropbox，天然没有 `.b64`**。输入框里的路径始终隐藏 `.b64`（如果存在），但实际提交/复制的路径包含它，agent 能正确读取文件。

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
| Host 半（`lib/index.js`） | 宿主进程，`inject: ['webServer']` | HTTP 路由 `/api/drop-file-to-path/begin\|chunk\|end\|abort\|list\|clean`：分块校验、两级去重、node:fs 落盘、清理接口 |
| Client 半（`lib/client.js`） | 浏览器（`__ModuleLoader__` bundle，`dsh.client` 声明） | 全局拖拽监听（capture 接管）、fetch 分块上传、待机圆环、注册 trigger source、经 `conversation.input.insertReference` 插入参考 chip、侧边栏清理入口 |

### 路径 chip

路径 chip 走 composer 原生的参考引用机制（U+FFFC 占位符 + occurrence 表 + 提交时 codec 序列化）：占位符在草稿里只占一个字符，因此整条路径是一个不可分割的整体；提交时经插件注册的 `drop-file-to-path` source 的 codec 把占位符展开为真实路径（含 `.b64`）。

**篮筐宽度自适应**：插件在插入前用 composer 的真实字体实测 label 宽度，算出 NBSP 空格数 `pad`，随 chip 一起插入（占位符 + pad 个 NBSP）。chip 单元格宽度 = 基础 1em + pad×空格宽 ≈ 文件名宽——**先有文件名，后有篮筐**。为此需要两处配套（都在本 DSH 发行版内）：

- **加宽字体**：用 `tools/patch-chip-font.mjs` 把 `DshChipCell` 的 U+FFFC advance 从 composer 默认 4em 改为 **1em**（同名字体族、后声明者生效，textarea/镜像/背板三层共享同一 advance，对齐关系不变）；
- **核心 composer 扩展**（`dsh-client-ui-conversation`）：occurrence 支持 `pad` 扩展占位区间——插入、序列化、复制/剪切投影、Backspace/Delete 整删、backdrop 渲染全部按 `[offset, offset+1+pad)` 整段处理。

**无该 composer 扩展的公开版 DSH（降级模式）**：`pad` 缺失时插件自动退回 `[offset, offset+1)`——chip 为固定 1em 宽（文件名按 composer 默认样式显示），提交/复制/刷新草稿全部正确，**不会损坏草稿**。

**chip 样式**：蓝色无底框样式由全局规则作用于参考 chip，与 v1.1.0 视觉一致。

### 上传、校验与去重

- **分块**：4194303 字节（4MiB−1，**3 的倍数**）——每满块的 base64 无中间填充符，拼接流可无损解码（4MiB 整块会在流中间嵌入 `==`，Node/Python 解码器都会在首个 `==` 处截断，>4MB 文件会损坏；v1.2.1 起修复）。
- **完整性**：`chunk` 阶段校验每块精确长度与 base64 合法性；`end` 阶段校验分块齐全、总量一致、解码后字节数 === 声明大小——截断/缺块/伪造数据一律拒绝，绝不落盘损坏文件。
- **两级去重**：`begin` 按名字+大小快速命中 dropbox 内已有文件 → 直接返回旧路径、**零上传**（重复拖同一文件秒出结果）；首次上传时 `end` 对完整内容算 sha256 与候选文件逐字节比对——命中则返回旧路径、不产生新副本，同名同大小但内容不同则落 `_1` 副本，绝不复用错误内容。

### 待机圆环（插入点加载动画）

- **触发**：只有真正需要等待的上传才显示——上传开始后延迟 150ms，若期间完成（极小文件、秒回去重）则**从不出现**；超过 150ms 才在插入点显示。
- **位置**：直接测量 composer 自己的 mirror 镜像层（与输入框同字体、同宽度、同滚动，天然对齐），定位到**光标/草稿末尾**，圆心再右移一个字符宽（"第二个字"位置）——不遮住已输入的文字。
- **外观**：16px DeepSeek 蓝（`#4d6bfe`）弧线圆环，渐隐拖尾 + 光晕，0.85s/圈持续旋转。
- **消失**：chip 插入的**同一瞬间**圆环立即移除（命令式 DOM 直接挂在 `document.body`，不经过 React/slot，无中间环节可吞掉它）。

### 清理入口

侧边栏脚部的**垃圾桶图标**（`sidebar.footer.action` 槽位，渲染在设置图标上方；悬停显示"清理 Dropbox"）点击后弹出右下角清理浮层，复用同一套清理逻辑（`/api/drop-file-to-path/list` + `/clean`）。

依赖官方服务：`webServer`（HTTP 路由）、`slots`（shell.overlay + conversation.composer.dock + sidebar.footer.action）、`inputTriggers`（source 注册与序列化）、`conversation`/`sessions`（按 session 解析输入门面）。除上述核心 occurrence 扩展外不修改 dsh 源码。

## 版本历史

- **v1.4.8**（当前）：待机圆环最终形态——延迟 150ms 显示（瞬间完成不出圈）、镜像层测量定位（光标右侧一个字符）、chip 插入瞬间同步消失；上一版（1.4.0–1.4.7）为迭代过程中的中间形态，仅以 v1.4.8 整体发布
- **v1.4.0**：清理入口从设置页改为**侧边栏垃圾桶图标**（设置图标上方，悬停提示）；移除设置内导航页
- **v1.3.0**：新增 **Dropbox 清理**功能（文件清单、冗余副本/按大小/清空三种清理模式、删除前确认）；新增 list/clean 路由
- **v1.2.3**：恢复 **begin 先查后传**快速去重（同名同大小秒回，零上传）；end 内容哈希兜底保留
- **v1.2.2**：chip 样式机制回退为全局规则（v1.2.0/1.2.1 的动态规则存在时序 bug 导致 chip 显示为默认样式）
- **v1.2.1**：修复 >4MB 文件解码截断（分块改为 3 的倍数）、end 完整性校验、草稿投影 pad 回退、Windows 保留名 sanitize
- **v1.1.0**：路径以蓝色 chip 整体插入、篮筐宽度自适应、begin 快速去重

## 开发

```sh
node --check lib/index.js lib/client.js   # 语法检查
node --test tests/host.test.mjs           # 宿主行为测试（21 例：上传/完整性/两级去重/清理/安全）
```

CI（`.github/workflows/ci.yml`）在 push/PR 时自动执行以上两步。

## 文件说明

```
├── lib/index.js            # Host 半：HTTP 上传路由 + 校验/去重/清理 + node:fs 落盘
├── lib/client.js           # Client 半：全局拖拽 + 待机圆环 + chip 插入 + 侧边栏清理入口
├── tools/patch-chip-font.mjs  # 生成加宽 DshChipCell 字体的工具（改宽度后重跑）
├── tests/host.test.mjs     # 宿主行为测试（node --test，免 DSH 服务器）
├── chip-cell-font.b64      # 加宽字体产物（client.js 内嵌同一份）
├── cordis.patch.yml        # bundle 补丁层（insert 插件行）
├── .github/workflows/ci.yml # CI：语法检查 + 宿主测试
├── .gitignore
└── package.json            # dsh.bundle.patch + dsh.client 声明
```

## 落盘与读取约定

- 落盘目录：`C:\Users\<用户>\.dsh-dropbox\`（`os.homedir()` 解析；测试可用 `DSH_DROPBOX_DIR` 覆盖）
- `.b64` 解码（agent 侧）：见上文 `.b64` 说明

## License

MIT
