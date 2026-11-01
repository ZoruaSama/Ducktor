# Ducktor 文件格式规范 v0.5

## 1. 概述

Ducktor 是一种用于在 VSCode 中提供代码解释信息的文件格式。插件读取项目目录中的 `.ducktor` 文件，在用户鼠标悬浮到对应代码位置时显示解释内容。

`.ducktor` 文件只负责**声明解释信息**，不关心解释内容如何生成。内容可由开发者手写，也可由 AI 自动生成。

## 2. 文件定位

- **文件扩展名**：`.ducktor`
- **推荐命名**：`<code-file>.ducktor`，例如 `main.js.ducktor`
- **文件位置**：每个工作区根目录的 `.ducktor` 目录内，按源码相对根目录的路径镜像存放；例如 `src/main.js` 对应 `.ducktor/src/main.js.ducktor`
- **默认作用范围**：镜像路径对应的源码文件；不再读取源码旁的同名 `.ducktor` 文件
- **目录维护**：由用户或外部工具建立和维护；插件只按路径读取，不创建、迁移或跟随源码重命名维护目录。缺失文件不显示解释。多根工作区各自读取根目录的 `.ducktor`；已有清除命令仅删除镜像目录中的解释文件，不删除目录。
- **编码**：UTF-8
- **格式**：YAML
- **内容字段**：支持 Ducktor 扩展 Markdown

## 3. 基本结构

每个 `.ducktor` 文件由两部分组成：

1. **`blocks` 列表**：解释块，用于解释代码段。
2. **`terms` 列表**：术语表，用于解释关键符号（类、变量、常量等）。

新版顶层为对象，包含 `blocks: []` 和 `terms: []`；未使用的列表可以留空。旧版仅包含解释块的顶层纯列表仍受支持，但不能在该列表后混写顶层 `terms` 映射。

```yaml
# 解释块列表
blocks:
  - range: 10-15
    anchor:
      type: function
      name: initDB
    content: |
      初始化数据库连接池。

# 术语表
terms:
  - symbol: dbConfig
    type: variable
    content: |
      数据库配置对象。
```

## 4. 解释块字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `range` | 字符串或数字 | 是 | 行号、行范围或 `*` |
| `anchor` | 对象或字符串 | 否 | 用于对齐代码位置的锚点 |
| `content` | 字符串 | 是 | 整体解释文本，支持 Hover、右侧面板和独立预览页显示 |
| `lines` | 对象列表 | 否 | 逐行说明，每项包含源码行号 `line` 和 Markdown 字符串 `content`，仅独立预览页展示 |
| `enabled` | 布尔值 | 否 | 默认 `true` |
| `tags` | 字符串列表 | 否 | 例如 `["db", "core"]` |

## 5. range 规则

`range` 支持三种写法：

```yaml
range: 10
range: 10-15
range: "*"
```

插件优先使用 `anchor` 对齐位置；对齐失败时降级使用原始 `range`。

### 5.1 独立双列预览

原有 Hover 和右侧预览保持不变，只显示代码块或术语的整体 `content`。如果当前源码文件有启用且有效的逐行解释，文件最顶部显示 CodeLens 入口“📖逐行解释”（需要编辑器启用 CodeLens），点击后在当前编辑器区域打开独立标签页；该入口不受 `ducktor.displayMode` 影响，独立页和右侧面板可以同时存在。

独立页汇总当前文件所有包含有效 `lines` 的代码块，默认进入逐行解释。顶部直接切换“整体说明”和“逐行解释”：整体说明以页面正文显示这些块的 `content`，不使用浮窗；逐行解释左列为只读的完整源码，右列为 `lines` 中的完整 Markdown，未说明的源码行右列留空。点击源码行号可回到编辑器，点击解释旁的行号可定位并高亮对应源码行。

双列位于同一个滚动容器，每个源码行与解释共用一行 CSS Grid 布局。两列使用相同的编辑器字体、字号和行高，源码换行或解释内容较长时一起撑高该行，因此无需与原生编辑器同步滚动，不受折叠、CodeLens 或平滑滚动影响。页面记住两种视图各自的滚动位置。

```yaml
blocks:
  - range: 39-47
    anchor: "let anchor = item.anchor"
    content: |
      锚点规范化与校验
      将简写锚点转换为对象，再校验类型和参数。
    lines:
      - line: 39
        content: "读取该解释块的 `anchor` 配置。"
      - line: 40
        content: "字符串简写转换成 `{ type: 'text', name: anchor }`。"
      - line: 42
        content: "拒绝不支持的锚点类型。"
```

`line` 为与 `range` 对应的原始源码行号（从 1 开始），必须位于块范围内且不重复；可以只说明部分行。列表按行号排序。锚点使整个块移动时，逐行位置按相对块起点的偏移一起移动；文件末尾越界的说明不显示。`range: "*"` 时使用文件行号。块内部增删行后仍需更新这些行号。

## 6. anchor 规则

### 6.1 结构化锚点

```yaml
anchor:
  type: function
  name: initDB
```

支持的 `type`：

- `function`
- `class`
- `method`
- `variable`
- `constant`
- `comment`
- `text`
- `hash`

### 6.2 文本锚点

```yaml
anchor: "function initDB"
```

等价于：

```yaml
anchor:
  type: text
  name: "function initDB"
```

### 6.3 哈希锚点

```yaml
anchor:
  type: hash
  value: "a1b2c3d4"
```

哈希锚点用于精确匹配某一行代码内容。插件可对目标行代码计算稳定哈希，例如 SHA-256 前 8 位。

### 6.4 匹配优先级

1. 哈希锚点匹配
2. 文本/结构化锚点匹配
3. 原始 `range` 兜底
4. 完全失效时隐藏

## 7. content 字段：Ducktor 扩展 Markdown

`content` 使用 Markdown 子集，并扩展四类链接和两种样式标记。

### 7.1 加粗、斜体、删除线

| 语法 | 效果 | 说明 |
|---|---|---|
| `**text**` | 加粗 | 推荐 |
| `*text*` | 斜体 | 推荐 |
| `***text***` | 粗斜体 | 可选 |
| `~~text~~` | 删除线 | 适合表示废弃内容 |

### 7.2 标题

支持 H1-H4：

```yaml
content: |
  ### 函数说明
  这里负责初始化数据库连接池。
```

规则：

- 允许 `#` 到 `####`
- 不建议在单个 `content` 中使用超过一个 H1
- 标题后建议保留空行
- 标题内不建议嵌套链接、颜色、下划线

### 7.3 列表

```yaml
content: |
  - 初始化连接池
  - 校验配置
  - 创建单例实例

  1. 读取配置
  2. 创建连接
  3. 启动健康检查
```

规则：

- 支持 `-`、`*`、`+` 作为无序列表标记
- 支持 `1.`、`2.` 有序列表
- 支持一级嵌套，不建议超过两级
- 列表项中可包含加粗、斜体、代码、链接
- 列表项中不建议嵌套标题或代码块

### 7.4 代码与引用

```yaml
content: |
  调用 `initDB()` 前需要确保 `dbConfig` 已加载。

  > 注意：不要在这里直接创建多个连接池。
```

规则：

- 支持行内代码：`` `code` ``
- 支持代码块
- 支持引用块：`> text`
- 不建议在 Hover 中使用表格，渲染效果不稳定

### 7.4.1 Mermaid 图表与源码节点导航

在 `blocks[].content` 或 `terms[].content` 中使用语言名为 `mermaid` 的围栏代码块。支持流程图 `flowchart`、用 `subgraph` 表达框架/架构图、类图 `classDiagram`、时序图 `sequenceDiagram` 和状态图 `stateDiagram-v2`。不支持 PlantUML 语法，也不承诺 Mermaid 的所有实验性图类型。

**仅右侧解释预览渲染图表**。Hover、独立逐行预览（含其块概览页签）保留 Mermaid 原始代码块；`lines[].content` 中的图表也不渲染。

````yaml
blocks:
  - range: "1-30"
    content: |
      请求处理流程。

      ```mermaid
      flowchart LR
        subgraph Service[服务层]
          Receive[接收请求] --> Validate{校验通过?}
        end
        Validate -->|是| Execute[执行业务]
        Validate -->|否| Reject[返回错误]
        %% ducktor-link {"node":"Receive","target":"./handler.ts#3-8"}
        %% ducktor-link {"node":"Execute","target":"./service.ts#12-25"}
      ```
terms: []
````

源码节点映射规则：

- 每条映射独占一行，格式为 `%% ducktor-link {"node":"节点ID","target":"源码路径#行号或范围"}`，后接严格 JSON，不使用 YAML 对象或 Mermaid 原生 `click`。
- `node` 使用 Mermaid 中显式定义的 ID，而非展示文字；允许 ASCII 字母、数字、下划线和连字符。每个图内同一 ID 只能映射一次，不同图可复用 ID。
- `target` 必须包含 **1 基行号**，例如 `./handler.ts#3` 或 `../service.ts#12-25`。路径相对于当前解释对应的源码目录；术语解释则相对于声明该术语的源码目录。复用文件链接的工作区边界、真实路径及行范围校验，不允许工作区外文件或 URL/命令协议。
- 点击绑定节点，或聚焦后按 Enter/空格，打开源码并选中指定行范围。流程图节点与类图类节点支持绑定；不存在的文件、无效范围或找不到的图形 ID 不生成可点击节点。
- 时序图、状态图支持绘制，但不保证其内部元素的源码绑定；需要导航时使用流程图或类图，或在图后添加普通源码链接。
- 图表离线渲染，不访问远程服务。禁止图内配置覆盖（frontmatter、`%%{init: ...}%%`）、原生 `click`/`href`、HTML 标签、图片与图标资源。
- 无效映射或 Mermaid 语法导致该图降级为原始代码块并显示错误，不影响其他图或正文。图中文字应使用普通文本，避免 HTML 换行。

类图示例：

````yaml
content: |
  认证模块类关系。

  ```mermaid
  classDiagram
    class AuthService {
      +authenticate(token)
    }
    class UserRepository {
      +findById(id)
    }
    AuthService --> UserRepository
    %% ducktor-link {"node":"AuthService","target":"./auth.ts#10-40"}
  ```
````

### 7.5 颜色标记

颜色使用扩展语法，不使用 HTML 或 CSS。

```
{!red 警告}
{!blue 说明}
{!green 安全}
{!orange 注意}
{!yellow 提示}
{!gray 次要信息}
```

规则：

- 只允许预定义颜色：`red`、`blue`、`green`、`orange`、`yellow`、`gray`
- 不允许任意十六进制颜色
- 不允许背景色、字体大小、字体族等复杂样式
- 颜色标记只适合短文本提示
- 右侧面板和独立预览支持实际文字颜色；Hover 因宿主限制显示为普通文本，不显示颜色

### 7.6 下划线标记

```
{_重要字段}
```

规则：

- `{_text}` 表示下划线强调
- 不建议嵌套链接
- 不建议嵌套颜色标记
- 右侧面板和独立预览显示下划线；Hover 因宿主限制显示为普通文本

## 8. content 链接语法

### 8.1 文件跳转链接

```
[src/auth.ts#12]
[src/auth.ts#12-20]
[config/db.yaml]
```

行为：

- 打开目标文件
- 支持行号或行范围
- 路径相对于镜像映射所对应的**源码文件所在目录**，不是 `.ducktor` 内的目录；例如 `.ducktor/src/main.js.ducktor` 中的 `[../lib/util.js]` 跳转至 `lib/util.js`
- 必须解析为工作区内的绝对路径

### 8.2 符号跳转链接

```
[createPool]
[AuthService]
[UserService.validate]
```

行为：

- 插件在工作区内搜索匹配符号
- 优先匹配函数名、类名、方法名
- 匹配到多个符号时弹出选择列表
- 未匹配到符号时显示为普通文本

可显式指定语言：

```
[createPool:ts]
[UserService.validate:js]
```

### 8.3 外部文档链接

```
<https://example.com/auth>
[认证流程文档](https://example.com/auth)
[RateLimiter 设计](../docs/rate-limiter.md)
```

行为：

- `https://`、`http://` 链接在浏览器中打开
- 工作区内的 `.md`、`.txt`、`.ducktor` 文件在编辑器中打开，路径相对于源码文件所在目录
- 文档必须提供真实 URL 或文件路径；`<认证流程文档>` 这样的名称不会自动匹配文档标题
- 不允许 `javascript:`、`data:`、`file:` 等危险协议

## 9. skills 生成规则
待我后续补充

## 10. 术语表 terms

术语表用于解释代码中的关键符号（类、变量、常量、配置项等），与代码段解释互补。

### 10.1 顶层结构

```yaml
# 代码段解释
blocks:
  - range: 10-15
    anchor:
      type: function
      name: initDB
    content: |
      这里根据配置初始化数据库连接池。

# 术语表
terms:
  - symbol: MAX_RETRY
    type: constant
    content: |
      最大重试次数。
      默认值为 `3`，超过后会触发降级。

  - symbol: dbConfig
    type: variable
    content: |
      数据库配置对象。
      包含主机、端口、库名和连接池参数。
```

### 10.2 术语项字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `symbol` | 字符串 | 是 | 被解释的符号名，如 `MAX_RETRY`、`AuthService` |
| `type` | 字符串 | 否 | 符号类型，如 `class`、`variable`、`constant`、`enum`、`config` |
| `scope` | 字符串 | 否 | 作用范围：`global`、`module`、`local`，默认 `global` |
| `block` | 整数 | `local` 时是 | 绑定 `blocks` 原始列表中的 1 基解释块编号 |
| `aliases` | 字符串列表 | 否 | 别名，如 `["pool", "dbPool"]` |
| `content` | 字符串 | 是 | 术语解释文本，使用 Ducktor 扩展 Markdown |
| `enabled` | 布尔值 | 否 | 默认 `true` |
| `tags` | 字符串列表 | 否 | 例如 `["db", "config"]` |

### 10.3 触发规则

术语解释不应在每次悬浮时都全部展示，而是按"命中即展示"的方式触发。

**关键词命中触发**：匹配 `terms` 中 `symbol` 或 `aliases` 的关键词会显示点划线下划线标记，悬停该关键词时触发术语解释。术语展示跟随 `ducktor.displayMode`：`hover` 模式在悬浮面板显示正文及右侧面板入口，`panel` 模式仅显示右侧面板入口，不展示悬浮正文。

代码块解释仍通过代码块首行行末的 `📝 Ducktor` 标记触发，不因悬停任意代码位置而展示；同样遵循 `ducktor.displayMode`。

匹配优先级：

1. 完全匹配 `symbol`
2. 匹配 `aliases`
3. 忽略大小写匹配
4. 未命中则不展示术语解释

同一命中等级内，作用域优先级为 `local > module > global`；作用域不会改变上述 `symbol`、`aliases`、忽略大小写的匹配优先级。

例如：

```yaml
terms:
  - symbol: pool
    aliases:
      - dbPool
      - connectionPool
    content: |
      全局数据库连接池。
      由 [initDB] 创建，被多个服务共享。
```

当用户悬浮到 `pool`、`dbPool` 或 `connectionPool` 时，都可以命中这条解释。

### 10.4 作用范围控制

`scope` 用来控制术语解释的适用范围：

- `global`：项目级术语，仅在同一个工作区文件夹内的源文件生效，不跨工作区文件夹。
- `module`：仅在该 `.ducktor` 对应的同名源文件内生效，例如 `core.js.ducktor` 对应 `core.js`。
- `local`：必须提供 `block`，其值为 `blocks` 原始列表中的 **1 基编号**，不是过滤禁用或无效块后的编号。仅在对应块经 `resolveBlock` 重定位后的 `start` 到 `end`（含边界）内生效；禁用、无效或无法定位的块不生效。

如果未指定 `scope`，默认按 `global` 处理。

### 10.5 内容生成规则

术语解释的 `content` 仍然遵循 Ducktor 扩展 Markdown，但建议更短、更聚焦。

建议规则：

- 术语解释默认不超过 3 句话
- 优先说明：它是什么、它从哪里来、谁在使用它
- 可以引用相关符号，例如 `[initDB]`、`[RateLimiter]`
- 不建议展开完整实现细节
- 如果解释过长，应拆成代码段解释，而不是堆在术语里

### 10.6 AI 生成术语解释的规则

1. **只解释必要的符号。** 不解释所有变量，只解释影响理解的关键类、常量、配置、状态变量。
2. **每个术语只回答一个核心问题。** "这个符号是什么"，不要写成整段代码流程分析。
3. **避免重复代码段解释。** 如果某段逻辑已经在 `content` 中解释过，术语解释只补充符号本身的含义。
4. **优先解释跨模块共享的符号。** 例如全局常量、配置对象、单例、核心类、共享状态。
5. **局部变量默认不进入术语表。** 除非该局部变量承载了重要业务含义。

## 11. 完整示例

```yaml
# main.js.ducktor

# 代码段解释
blocks:
  - range: 10-15
    anchor:
      type: function
      name: initDB
    content: |
      ### 初始化数据库连接池

      这里会根据 `dbConfig` 创建连接池。
      核心逻辑见 [createPool]。

      - 使用单例模式
      - 失败时触发重试
      - 超时时间由 `POOL_TIMEOUT` 控制

      {!red 警告}：不要在这里直接创建多个连接池。
      {_MAX_RETRY} 与 RateLimiter 阈值保持一致。

      > 注意：修改连接池大小可能影响事务提交顺序。

  - range: 22-40
    anchor: "class AuthService"
    content: |
      负责用户登录和权限判断。
      依赖 [TokenValidator] 校验 Token。
      详细流程见 <认证流程文档>。

  - range: 48
    anchor:
      type: constant
      name: MAX_RETRY
    content: |
      最大重试次数。

      1. 默认值为 `3`
      2. 超过后会抛出错误
      3. 需要同时检查 [RateLimiter] 配置

      相关实现：[TransactionCommitter]
      测试用例：[transaction.test.ts]

  - range: 60-65
    anchor:
      type: hash
      value: "a1b2c3d4"
    content: |
      这段代码影响事务提交顺序。
      相关实现在 [TransactionCommitter]。
    enabled: true
    tags:
      - db
      - transaction

  - range: "*"
    content: |
      本项目使用 TypeScript。
      所有异步方法必须返回 Promise。
      规范见 <开发规范文档>。

# 术语表
terms:
  - symbol: dbConfig
    type: variable
    scope: module
    content: |
      数据库配置对象。
      包含 `host`、`port`、`database` 和 `poolSize`。

  - symbol: MAX_RETRY
    type: constant
    scope: module
    content: |
      连接失败时的最大重试次数。
      默认值为 `3`，修改后需要同步检查 [RateLimiter]。

  - symbol: RateLimiter
    type: class
    content: |
      限流器。
      用于控制单用户并发请求数，防止连接池被打满。
      详细实现见 [RateLimiter.acquire]。

  - symbol: pool
    type: variable
    aliases:
      - dbPool
      - connectionPool
    content: |
      全局数据库连接池。
      由 [initDB] 创建，被 [AuthService] 和 [OrderService] 共享。
```

## 12. 渲染与安全规则

- 悬浮内容使用 VSCode `MarkdownString` 渲染。
- 必须启用 `isTrusted`，否则命令链接无法生效。
- VSCode Hover 不支持任意 HTML，禁止 `<script>`、`<style>`、`<iframe>`、`<img>`、`onerror` 等标签。
- 链接只允许四种目标：文件、符号、外部 URL、插件自有命令。
- 禁止 `javascript:`、`data:`、`file:` 协议链接。
- 文件链接必须解析到工作区内。
- 符号链接失败时应降级为普通文本。
- 命令链接只能调用插件白名单命令。
- 扩展语法解析失败时应降级为普通文本，不阻断渲染。
- 渲染前应对 Markdown 特殊字符做必要转义，避免 `_`、`*`、`` ` `` 破坏格式。
- 术语解释在悬浮面板中应独立区域展示，与代码段解释区分。
