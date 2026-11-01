# 核心文件标准 · Ducktor

## 定位与编码

- 使用 UTF-8 YAML，扩展名 `.ducktor`。
- 每个工作区根各有 `.ducktor` 目录，镜像源码相对根的路径。
- 源码 `src/main.js` 对应 `.ducktor/src/main.js.ducktor`；不要写在源码旁。
- 插件只读取，不负责创建目录、迁移或跟随源码重命名。多根工作区分别维护。
- 生成 agent 负责建立输出目录：确认源码所属工作区根后，自行递归创建缺失的 `.ducktor` 及目标镜像父目录，无需用户预先建立。例如输出 `.ducktor/src/main.js.ducktor` 前，确保 `.ducktor/src` 存在；保留已有目录和文件，只创建本次输出需要的目录。不要把终端当前子目录误当作工作区根。

## 顶层与字段

新生成文件统一使用对象，包含 `blocks` 与 `terms` 两个列表，未使用者写 `[]`。插件兼容旧版纯 blocks 列表，但不要生成旧格式，也不要把列表与顶层 terms 混写。等级与能力仅控制生成，不添加 `level`、`capabilities`、解释块 ID 等未定义字段。

解释块字段：

| 字段 | 类型 | 约束 |
|---|---|---|
| range | 字符串或数字 | 必填；单行、闭区间或 `"*"` |
| content | 字符串 | 必填；整体说明，Ducktor 扩展 Markdown |
| anchor | 字符串或对象 | 可选；用于重定位 |
| lines | 对象列表 | 可选；每项包含整数 line 与字符串 content |
| enabled | 布尔值 | 可选；默认 true |
| tags | 字符串列表 | 可选；不为凑字段生成标签 |

## 范围与锚点

- 源码行号从 1 开始；闭区间如 `range: "10-15"`，单行如 `range: 10`。
- `range: "*"` 表示整个文件，必须引号包裹。默认使用实际代码块范围，不以全文件范围掩盖定位问题。
- 优先锚点对齐，失败时以原始 range 兜底，完全失效隐藏；因此 range 也必须准确。
- 结构化锚点 `type` 只允许 function、class、method、variable、constant、comment、text、hash。
- 非 hash 对象提供 `name`。文本简写等价于 type 为 text 的对象。
- 锚点应对应块起点的真实源码。声明重名、装饰器或多行签名使定位不可靠时，使用确认过的文本锚点或保留准确 range，不伪造唯一性。
- hash 锚点提供 `value`。规范提到稳定行哈希，例如 SHA-256 前 8 位，但未固定全部计算细节；仅在确认目标插件算法并实际计算后使用，禁止填示例哈希。
- 插件匹配优先级为 hash、文本/结构化、原始 range。一个块不同时配置多个互斥锚点。

## YAML 写法

- content 默认使用 `|` 块字符串，统一空格缩进，禁止 Tab。
- 含 Markdown、冒号、井号、多行文本时避免未加引号的单行标量。
- 不使用重复键、多文档 YAML、可执行自定义标签。
- 生成后用真实 YAML 解析器验证，不能只检查扩展名或缩进。

## 结构示例

以下行号仅示意；生成时必须从目标源码取得。

```yaml
blocks:
  - range: "10-15"
    anchor:
      type: function
      name: initDB
    content: |
      根据连接配置创建数据库连接池，供后续数据库操作使用。
terms: []
```

若仅生成术语，使用 `blocks: []`，另填写 terms。整体 content 在 Hover、右侧面板及独立预览中展示；逐行 lines 仅在独立预览页展示，不能用 lines 代替必填 content。
