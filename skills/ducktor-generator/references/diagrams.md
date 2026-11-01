# 图表标准

用于在 `.ducktor` 的说明中绘制 Mermaid 图表，并把节点绑定到源码位置。何时需要图表见[能力与等级](capabilities.md)中的 H。

## 放置位置与显示边界

- 只写在 `blocks[].content` 或 `terms[].content` 中，使用语言名为 `mermaid` 的 Markdown 围栏代码块。不要新增 YAML 字段。
- 不写入 `lines[].content`；逐行说明中的图表不会渲染。
- 插件**仅在右侧解释面板渲染图表**。Hover 和独立逐行预览（含其块概览页签）显示原始代码，因此图前后的文字必须能独立讲清要点，不让图承担唯一说明。
- 每个图独立，不跨图引用节点。

## 支持的图类型

| 用途 | 声明 | 源码节点绑定 |
|---|---|---|
| 执行流程、分支、数据流 | `flowchart TD` / `flowchart LR` | 支持 |
| 模块/框架/架构关系 | `flowchart` + `subgraph` | 支持（绑定节点，不绑定 subgraph） |
| 类型结构与协作 | `classDiagram` | 支持（绑定类 ID） |
| 调用时序、消息往返 | `sequenceDiagram` | 不保证 |
| 状态与生命周期 | `stateDiagram-v2` | 不保证 |

其他 Mermaid 图类型（如 gantt、mindmap、architecture-beta）和 PlantUML 均不支持，会降级为原始代码并显示错误。

## 源码节点映射

在图代码内单独成行添加：

```text
%% ducktor-link {"node":"节点ID","target":"源码路径#行号或范围"}
```

- 后接**严格 JSON**：键名和字符串使用双引号，不用 YAML 写法。
- `node` 是 Mermaid 中显式定义的节点 ID 或类名，不是展示文字；只用 ASCII 字母、数字、下划线、连字符。同一图内每个 ID 最多映射一次。
- `target` 必须带 **1 基行号**：`./handler.ts#3` 或 `../service.ts#12-25`。路径相对**被解释源码文件所在目录**（术语图相对声明该术语的源码目录），不是 `.ducktor` 目录。目标必须在工作区内且行范围真实存在。
- 不使用 URL、`command:`、符号名或无行号路径作为 target；需要符号或外部文档跳转时，在图外用普通 Markdown 引用。
- 只绑定读者确实需要跳转的关键节点；绑定前核对目标文件和行范围对应该节点含义。

## 安全与语法限制

以下内容会使整个图降级，不要写：

- 原生 `click`、`href`、任何链接协议或 URL。
- frontmatter（`---`）、`%%{init: ...}%%` 等配置覆盖。
- HTML 标签（包括 `<br>`）、图片、图标资源。

节点标签使用普通文本；含括号、问号等特殊字符时用 `A["标签"]` 形式加引号。中文标签可用。保持图小而聚焦：通常不超过约 15 个节点，复杂结构拆成多个块或只画主干。

## 在 YAML 中书写

`content` 使用 `|` 块标量，Mermaid 代码相对 `content` 统一缩进；围栏与图代码不要混用 Tab。

````yaml
blocks:
  - range: "1-30"
    anchor:
      type: function
      name: handleRequest
    content: |
      校验请求后执行业务，校验失败直接返回错误。

      ```mermaid
      flowchart LR
        subgraph Service[服务层]
          Receive[接收请求] --> Validate{"校验通过?"}
        end
        Validate -->|是| Execute[执行业务]
        Validate -->|否| Reject[返回错误]
        %% ducktor-link {"node":"Receive","target":"./handler.ts#3-8"}
        %% ducktor-link {"node":"Execute","target":"./service.ts#12-25"}
      ```
terms: []
````

类图示例：

````yaml
content: |
  `AuthService` 通过 `UserRepository` 查询用户。

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
    %% ducktor-link {"node":"UserRepository","target":"./user-repository.ts#5-30"}
  ```
````

## 检查

- 首个非注释行是受支持的图声明；无禁止语法。
- 每条 `ducktor-link` 是合法 JSON，`node` 在图中存在，`target` 路径存在且行范围覆盖对应实现。
- 图中关系与源码一致：不画源码中不存在的调用、分支、继承或依赖；推断关系不入图，或在图外标为待核实。
- 去掉图后文字仍能说明核心结论；图与文字不矛盾。
- 静态检查通过不等于插件渲染验证通过，报告时不要混淆。
