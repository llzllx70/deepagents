# create_agent() 流程图与说明

下面是 `create_agent()` 的流程图（Mermaid），可直接在支持 Mermaid 的 Markdown 渲染器中查看。

```mermaid
flowchart TD
    A["开始 create_agent()"] --> B{model 是字符串?}
    B -- 是 --> B1["init_chat_model"]
    B -- 否 --> C
    B1 --> C["system_prompt -> SystemMessage"]
    C --> D{tools 为 None?}
    D -- 是 --> D1["tools = []"]
    D -- 否 --> E
    D1 --> E["处理 response_format -> initial_response_format"]
    E --> F{AutoStrategy?}
    F -- 是 --> F1["tool_strategy_for_setup"]
    F -- 否 --> G
    F1 --> G["生成 structured_output_tools"]
    G --> H["收集中间件 tools"]
    H --> I["收集 wrap_tool_call/awrap_tool_call 并链式包装"]
    I --> J["分离 built_in_tools(dict) / regular_tools"]
    J --> K["构建 ToolNode(若有 client-side tools)"]
    K --> L["默认 tools = ToolNode工具 + 内建工具"]
    L --> M["校验中间件唯一性&收集各类 hook"]
    M --> N["链式包装 wrap_model_call/awrap_model_call"]
    N --> O["合并 state_schema -> resolved/input/output schema"]
    O --> P["创建 StateGraph"]
    P --> Q["定义模型调用逻辑<br/>_get_bound_model / _handle_model_output"]
    Q --> R["添加 model 节点"]
    R --> S{有 ToolNode?}
    S -- 是 --> S1["添加 tools 节点"]
    S -- 否 --> T
    S1 --> T["添加 middleware 节点"]
    T --> U["计算 entry/loop/exit 节点"]
    U --> V["添加边: START -> entry"]
    V --> W{有 tools?}
    W -- 是 --> W1["添加 model-tools 条件边"]
    W -- 否 --> X{仅 structured_output_tools?}
    X -- 是 --> X1["添加 model-model 条件边"]
    X -- 否 --> Y["添加 model -> exit 或 after_model -> exit"]
    W1 --> Z["连接 before/after middleware 边"]
    X1 --> Z
    Y --> Z
    Z --> AA["graph.compile(...).with_config"]
    AA --> AB["返回 CompiledStateGraph"]
```

## 简单说明
- `model` 为字符串时先初始化为实际的聊天模型实例。
- `response_format` 会被解析为结构化输出策略，必要时创建结构化工具。
- 工具分为内建（dict）和客户端工具（ToolNode），并接入中间件的 tool wrapping。
- 中间件 hook 会被收集并串联，用于在模型调用前后插入逻辑。
- 最终构建 `StateGraph`，按条件边实现“模型↔工具”的循环，或无工具时直接结束。

## deepagents_cli 启动后的 graph 结构

以下图示基于当前 CLI 默认启动流程（本地模式、`auto_approve=False`）。

### 完整中间件栈

```
调用顺序: START → 中间件 → Model → 中间件 → ToolNode → 中间件 → Model → ...

┌─────────────────────────────────────────────────────────────────────────────┐
│                          CLI 特定中间件 (agent_middleware)                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. AgentMemoryMiddleware (enable_memory=True)                               │
│    ├─ before_agent: 加载 user_memory + project_memory                       │
│    └─ wrap_model_call: 注入记忆到 system_prompt                             │
│                                                                             │
│ 2. SkillsMiddleware (enable_skills=True)                                   │
│    ├─ before_agent: 发现并加载 skills_metadata                              │
│    └─ wrap_model_call: 注入 skills 文档到 system_prompt                     │
│                                                                             │
│ 3. ShellMiddleware (仅本地模式, enable_shell=True)                          │
│    └─ 提供 shell 工具 (无 hooks)                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        核心中间件栈 (deepagent_middleware)                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. TodoListMiddleware                                                       │
│    └─ 提供 write_todos, read_todos 工具 (无 hooks)                           │
│                                                                             │
│ 5. FilesystemMiddleware                                                     │
│    ├─ 提供 ls, read_file, write_file, edit_file, glob, grep, execute 工具   │
│    ├─ wrap_model_call: 添加 <env> 标签到 system_prompt                      │
│    └─ wrap_tool_call: 包装工具调用                                          │
│                                                                             │
│ 6. SubAgentMiddleware ⭐                                                     │
│    ├─ 提供 task 工具 (派生子代理)                                            │
│    └─ wrap_model_call: 注入 task 系统提示                                   │
│                                                                             │
│ 7. SummarizationMiddleware                                                  │
│    ├─ before_model: 检查是否需要摘要 (~170k tokens)                         │
│    └─ after_model: 摘要后截断消息                                           │
│                                                                             │
│ 8. AnthropicPromptCachingMiddleware                                         │
│    └─ wrap_model_call: 启用系统提示缓存 (Anthropic 专用)                    │
│                                                                             │
│ 9. PatchToolCallsMiddleware                                                 │
│    └─ before_agent: 修复中断后悬空的工具调用                                │
│                                                                             │
│ 10. HumanInTheLoopMiddleware (auto_approve=False 时添加)                    │
│     ├─ after_model: 检查是否需要人工确认 (interrupt_on 工具)                │
│     └─ before_model: 用户确认后继续                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Graph 执行流程图

```mermaid
flowchart TD
    subgraph CLI["CLI 特定中间件"]
        AMM["AgentMemoryMiddleware<br/>├─ before_agent: 加载记忆<br/>└─ wrap_model_call: 注入记忆"]
        SM["SkillsMiddleware<br/>├─ before_agent: 发现 skills<br/>└─ wrap_model_call: 注入 skills"]
        ShM["ShellMiddleware<br/>└─ 提供 shell 工具<br/>(仅本地模式)"]
    end

    subgraph Core["核心中间件栈"]
        TLM["TodoListMiddleware<br/>└─ write_todos, read_todos"]
        FSM["FilesystemMiddleware<br/>├─ 7个文件工具<br/>└─ wrap_model_call: <env>"]
        SAM["SubAgentMiddleware<br/>├─ task 工具 ⭐<br/>└─ wrap_model_call"]
        SumM["SummarizationMiddleware<br/>├─ before_model: 检查摘要<br/>└─ after_model: 截断"]
        APCM["AnthropicPromptCachingMiddleware<br/>└─ wrap_model_call"]
        PTCM["PatchToolCallsMiddleware<br/>└─ before_agent: 修复悬空调用"]
        HITLM["HumanInTheLoopMiddleware<br/>├─ after_model: 人工确认<br/>└─ before_model: 继续执行"]
    end

    subgraph SubAgents["SubAgent 嵌套中间件栈 (由 SubAgentMiddleware 创建)"]
        STLM["TodoListMiddleware"]
        SFSM["FilesystemMiddleware"]
        SSumM["SummarizationMiddleware"]
        SAPCM["AnthropicPromptCachingMiddleware"]
        SPTCM["PatchToolCallsMiddleware"]
        SHITLM["HumanInTheLoopMiddleware<br/>(继承自主 agent)"]
    end

    START(__start__) --> PTCM
    PTCM --> AMM
    AMM --> SM
    SM --> ShM

    ShM --> TLM
    TLM --> FSM
    FSM --> SAM
    SAM --> SumM
    SumM --> APCM
    APCM --> HITLM

    HITLM -->|before_model| MODEL(model)
    MODEL -->|AI 消息| HITLM2["HITLM.after_model"]

    HITLM2 -->|无工具调用| END(__end__)
    HITLM2 -->|有工具调用| TN["ToolNode<br/>(执行所有工具)"]

    TN -->|task 工具| SAM_INVOKE["SubAgent.invoke<br/>(独立执行)"]
    SAM_INVOKE -->|返回结果| TN

    TN -->|工具结果| SumM2["SummarizationMiddleware<br/>检查是否摘要"]
    SumM2 --> APCM2["AnthropicPromptCachingMiddleware"]
    APCM2 --> HITLM3["HITLM.before_model"]
    HITLM3 -->|继续循环| MODEL

    SAM -.->|创建| SubAgents
    STLM --> SFSM --> SSumM --> SAPCM --> SPTCM --> SHITLM
    SHITLM --> SUBMODEL["子 Agent Model"]

    style AMM fill:#e1f5fe
    style SM fill:#fff3e0
    style ShM fill:#f3e5f5
    style SAM fill:#fff9c4
    style HITLM fill:#ffe0b2
    style SubAgents fill:#e8f5e9
```

### 调用时机说明

| 中间件 | Hook 类型 | 调用时机 | 说明 |
|--------|-----------|----------|------|
| **AgentMemoryMiddleware** | `before_agent` | Agent 启动时 | 加载 user_memory 和 project_memory |
| | `wrap_model_call` | 每次 Model 调用前 | 注入记忆到 system_prompt |
| **SkillsMiddleware** | `before_agent` | Agent 启动时 | 发现并列出可用 skills |
| | `wrap_model_call` | 每次 Model 调用前 | 注入 skills 文档到 system_prompt |
| **PatchToolCallsMiddleware** | `before_agent` | Agent 启动时 | 修复中断后悬空的 tool calls |
| **ShellMiddleware** | - | - | 提供 shell 工具，无 hooks |
| **TodoListMiddleware** | - | - | 提供 write_todos/read_todos，无 hooks |
| **FilesystemMiddleware** | `wrap_model_call` | 每次 Model 调用前 | 添加 `<env>` 标签到提示 |
| | `wrap_tool_call` | 工具调用时 | 包装文件操作 |
| **SubAgentMiddleware** | `wrap_model_call` | 每次 Model 调用前 | 注入 task 工具使用说明 |
| **SummarizationMiddleware** | `before_model` | Model 调用前 | 检查 token 数，决定是否摘要 |
| | `after_model` | Model 返回后 | 若已摘要，截断消息历史 |
| **AnthropicPromptCachingMiddleware** | `wrap_model_call` | 每次 Model 调用前 | 启用系统提示缓存 |
| **HumanInTheLoopMiddleware** | `after_model` | Model 返回后 | 检查 interrupt_on 工具，需确认时暂停 |
| | `before_model` | Model 调用前 | 用户确认后继续执行 |

### SubAgent 执行流程

当 Model 调用 `task` 工具时：

```
Main Agent
    │
    ├── Model 决定调用 task(description="...", subagent_type="general-purpose")
    │
    ▼
ToolNode 执行 task 工具
    │
    ├── 1. 验证 subagent_type 是否存在
    ├── 2. 过滤状态 (排除 messages, todos)
    ├── 3. 创建新状态: {messages: [HumanMessage(description)]}
    │
    ▼
SubAgent.invoke(subagent_state)  ← 独立执行，完整 middleware 栈
    │
    │   SubAgent 内部中间件栈:
    │   ├── TodoListMiddleware
    │   ├── FilesystemMiddleware
    │   ├── SummarizationMiddleware
    │   ├── AnthropicPromptCachingMiddleware
    │   ├── PatchToolCallsMiddleware
    │   └── HumanInTheLoopMiddleware (继承自主 agent)
    │
    ▼
SubAgent 完成任务 → 返回 {messages: [...], ...}
    │
    ▼
_return_command_with_state_update
    │
    └── Command(update={messages: [ToolMessage(result)]})
    │
    ▼
Main Agent 收到 ToolMessage → 继续推理
```

## create_deep_agent() 中间件栈结构

以下是基于 `libs/deepagents/deepagents/graph.py:111-160` 的 `deepagent_middleware` 栈结构图：

```mermaid
graph TD
    subgraph Main["deepagent_middleware 栈"]
        A["TodoListMiddleware<br/>write_todos, read_todos"]
        B["FilesystemMiddleware<br/>ls, read_file, write_file, edit_file, glob, grep, execute"]
        C["SubAgentMiddleware<br/>task - 派生子代理"]
        D["SummarizationMiddleware<br/>~170k tokens 自动摘要"]
        E["AnthropicPromptCachingMiddleware<br/>缓存系统提示"]
        F["PatchToolCallsMiddleware<br/>修复中断后的工具调用"]
        G{interrupt_on?}
        H["HumanInTheLoopMiddleware<br/>人工确认"]

        A --> B --> C --> D --> E --> F
        F --> G
        G -->|是| H
        G -->|否| I["create_agent()"]
        H --> I
    end

    subgraph SubAgent["SubAgent 嵌套中间件栈"]
        C1["TodoListMiddleware"]
        C2["FilesystemMiddleware"]
        C3["SummarizationMiddleware"]
        C4["AnthropicPromptCachingMiddleware"]
        C5["PatchToolCallsMiddleware"]

        C1 --> C2 --> C3 --> C4 --> C5
    end

    C -.->|嵌套| SubAgent

    I --> J["LangGraph Agent<br/>recursion_limit: 1000"]

    style A fill:#e3f2fd
    style B fill:#e3f2fd
    style C fill:#fff9c4
    style C1 fill:#fff9c4
    style C2 fill:#fff9c4
    style C3 fill:#f3e5f5
    style C4 fill:#f3e5f5
    style C5 fill:#f3e5f5
    style D fill:#f3e5f5
    style E fill:#f3e5f5
    style F fill:#f3e5f5
    style H fill:#ffe0b2
    style J fill:#c8e6c9
```

**说明：**
- 主中间件栈按顺序依次处理请求
- `SubAgentMiddleware` 内部嵌套了完整的子中间件栈
- 可选的 `middleware` 参数会追加到栈末尾
- 配置 `interrupt_on` 时会添加 `HumanInTheLoopMiddleware`


![1766996459717](image/remark/1766996459717.png) ![1766996520050](image/remark/1766996520050.png)


---

# Middleware、Tool、Task、Agent 类图

以下是基于源码分析的 DeepAgents 核心类关系图：

## 类图 (Mermaid)

```mermaid
classDiagram
    %% Base Types
    class BaseChatModel {
        <<abstract>>
    }
    class BaseTool {
        <<abstract>>
        +name: str
        +description: str
        +func: Callable
        +coroutine: Awaitable
    }
    class StructuredTool {
        +from_function()
    }
    BaseTool <|-- StructuredTool

    %% Agent State & Request/Response
    class AgentState {
        +messages: list
        +todos: list
    }
    class ModelRequest {
        +system_prompt: str
        +tools: list~BaseTool~
        +runtime: ToolRuntime
        +override()
    }
    class ModelResponse {
        +messages: list
    }
    class ToolRuntime {
        +state: AgentState
        +tool_call_id: str
    }
    class ToolCallRequest {
        +tool_call: dict
        +runtime: ToolRuntime
    }
    class Command {
        +update: dict
    }

    %% Middleware Base
    class AgentMiddleware {
        <<abstract>>
        +tools: list~BaseTool~
        +state_schema: type
        +wrap_model_call()
        +awrap_model_call()
        +wrap_tool_call()
        +awrap_tool_call()
        +before_agent()
        +after_agent()
    }

    %% Concrete Middleware
    class SubAgentMiddleware {
        +system_prompt: str
        +subagent_graphs: dict
        -_create_task_tool()
        -_get_subagents()
    }

    class FilesystemMiddleware {
        +backend: BackendProtocol
        +tools: list~BaseTool~
        +_get_backend()
        +wrap_model_call()
        +wrap_tool_call()
    }

    class PatchToolCallsMiddleware {
        +before_agent()
    }

    AgentMiddleware <|-- SubAgentMiddleware
    AgentMiddleware <|-- FilesystemMiddleware
    AgentMiddleware <|-- PatchToolCallsMiddleware

    %% Task Tool (Internal to SubAgentMiddleware)
    class TaskTool {
        +name: "task"
        +func: task()
        +coroutine: atask()
        -_validate_and_prepare_state()
        -_return_command_with_state_update()
    }
    StructuredTool <|-- TaskTool
    SubAgentMiddleware *-- TaskTool : creates

    %% SubAgent Types
    class SubAgent {
        <<TypedDict>>
        +name: str
        +description: str
        +system_prompt: str
        +tools: list
        +model: BaseChatModel
        +middleware: list
    }
    class CompiledSubAgent {
        <<TypedDict>>
        +name: str
        +description: str
        +runnable: Runnable
    }

    %% Agent Creation
    class CompiledStateGraph {
        <<LangGraph>>
        +invoke()
        +ainvoke()
        +stream()
    }
    class create_deep_agent {
        <<function>>
        +model: BaseChatModel
        +tools: list~BaseTool~
        +middleware: list~AgentMiddleware~
        +subagents: list~SubAgent~
    }

    %% Relationships
    create_deep_agent --> CompiledStateGraph : returns
    create_deep_agent --> SubAgentMiddleware : creates & configures
    create_deep_agent --> SubAgent : accepts (middleware param)

    SubAgentMiddleware --> SubAgent : creates from spec
    SubAgentMiddleware --> CompiledSubAgent : uses pre-compiled
    SubAgentMiddleware --> Runnable : creates (subagent graph)

    FilesystemMiddleware --> BaseTool : creates (7 tools)
    FilesystemMiddleware --> BackendProtocol : uses for storage/exec

    AgentMiddleware o-- BaseTool : provides to agent
    TaskTool ..> SubAgent : invokes via task()
    TaskTool ..> ToolRuntime : uses for state access
    TaskTool ..> Command : returns state update

    ModelRequest ..> AgentMiddleware : wrap_model_call() chain
    ModelRequest ..> ToolRuntime : contains runtime context
    ToolCallRequest ..> AgentMiddleware : wrap_tool_call() chain

    %% Backend
    class BackendProtocol {
        <<interface>>
        +ls_info()
        +read()
        +write()
        +edit()
        +glob_info()
        +grep_raw()
    }
    class SandboxBackendProtocol {
        <<interface>>
        +execute()
    }
    BackendProtocol <|-- SandboxBackendProtocol
```

## 关键关系说明

### 1. 中间件继承关系
```
AgentMiddleware (抽象基类)
    ├── SubAgentMiddleware (提供 task 工具)
    ├── FilesystemMiddleware (提供 7 个文件系统工具)
    └── PatchToolCallsMiddleware (修复悬空工具调用)
```

### 2. 工具创建关系
| Middleware | 创建的工具 |
|-----------|----------|
| `SubAgentMiddleware` | `task` (调用 subagent) |
| `FilesystemMiddleware` | `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute` |

### 3. 数据流向
```
create_deep_agent()
    │
    ├── 接收: tools, middleware, subagents
    │
    ├── 构建 middleware stack
    │   ├── TodoListMiddleware
    │   ├── FilesystemMiddleware ──→ 7 个文件工具
    │   ├── SubAgentMiddleware ──→ task 工具
    │   ├── SummarizationMiddleware
    │   └── PatchToolCallsMiddleware
    │
    └── 返回: CompiledStateGraph (Agent)
```

### 4. Task 调用流程
```
Main Agent
    │
    ├── 调用: task(description, subagent_type)
    │
    ↓
TaskTool (SubAgentMiddleware 提供)
    │
    ├── _validate_and_prepare_state() ──→ 过滤状态
    │
    ↓
SubAgent.invoke(state) ──→ 独立执行
    │
    ↓
_return_command_with_state_update()
    │
    └── 返回 Command(update={messages, ...}) ──→ ToolMessage → Main Agent
```

## 核心设计模式

1. **Middleware Pattern** - 通过中间件栈注入功能
2. **Factory Pattern** - `_create_task_tool()`, `_get_subagents()` 等工厂函数
3. **Strategy Pattern** - 不同 `BackendProtocol` 实现可插拔
4. **Chain of Responsibility** - Middleware 按顺序处理请求/响应


## 运行流程

![1767513655408](image/remark/1767513655408.png)

![alt text](image-2.png)

### 启动状态

![1767585550585](image/remark/1767585550585.png) 


### 完成 创建case目录结构与初始化文件

![1767585708191](image/remark/1767585708191.png)

### 完成 检查并抽取本地招生数据

![1767585811595](image/remark/1767585811595.png)


### 开始 制定分析计划

#### 写子任务的todos

![1767587042107](image/remark/1767587042107.png)

#### 生成 task-tool

#### 开始处理子任务

![1767587781935](image/remark/1767587781935.png)


#### 完成 
![1767585933609](image/remark/1767585933609.png)



![1767684637327](image/remark/1767684637327.png)