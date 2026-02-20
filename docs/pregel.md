# Pregel 一目了然：从实现细节抽象出系统原理

本文只讲 `langgraph/pregel/main.py` 中 `class Pregel` 的**实现级原理**，目标是：

1. 看清系统结构（有哪些部件、各自职责）
2. 看清运行原理（一轮怎么跑、状态怎么变）
3. 看清设计不变量（为什么这样实现）

---

## 0. 30 秒总览

`Pregel` 本质是一个**有 checkpoint 的超步执行引擎**。

- 输入：图定义（nodes/channels）+ 本轮 input/command + config
- 过程：循环执行 `Plan -> Execute -> Commit`
- 输出：stream 事件、最终 values、可恢复状态（checkpoint）

一句话：

> `Pregel` 不是“图描述器”，而是“图运行时内核”。

---

## 1. 系统结构图（先看这个）

## 1.1 核心对象关系

```text
Pregel
├─ Graph Definition
│  ├─ nodes: dict[str, PregelNode]
│  ├─ channels: dict[str, BaseChannel|ManagedValueSpec]
│  └─ trigger_to_nodes: channel -> subscribed nodes
│
├─ Runtime Services
│  ├─ checkpointer (state persistence / recovery)
│  ├─ store (shared values)
│  ├─ cache (node result cache)
│  └─ runtime(context, stream_writer, ...)
│
├─ Execution Engine
│  ├─ SyncPregelLoop / AsyncPregelLoop
│  ├─ PregelRunner (task execution)
│  └─ loop.tick() superstep loop
│
└─ Public APIs
   ├─ stream / astream
   ├─ invoke / ainvoke
   ├─ get_state / aget_state / state_history
   └─ update_state / bulk_update_state
```

`main.py` 里这些依赖都能直接看到：

- loop: `SyncPregelLoop`, `AsyncPregelLoop`
- runner: `PregelRunner`
- algo: `prepare_next_tasks`, `apply_writes`
- checkpoint: `channels_from_checkpoint`, `create_checkpoint`

---

## 1.2 `Pregel.__init__` 到底做了什么

位置：`main.py:631`

初始化时做 5 件关键事：

1. 把 `NodeBuilder` 编译成 `PregelNode`
2. 注入保留通道 `TASKS`（`Topic(Send, accumulate=False)`）
3. 绑定运行策略（interrupt、retry、cache、durability 默认来源）
4. 挂载 checkpointer/store/cache/runtime schema
5. `validate()` 并建立 `trigger_to_nodes` 索引

抽象原理：

- `nodes/channels` 是**静态拓扑**
- `checkpointer/store/cache` 是**运行时外部能力**
- `trigger_to_nodes` 是**调度索引**（决定谁被唤醒）

---

## 2. 运行原理（主循环）

## 2.1 真正的执行心跳

同步：`stream()` -> `while loop.tick(): ...`（`main.py:2643`）
异步：`astream()` -> `while loop.tick(): ...`（`main.py:2971`）

这就是 Pregel 模型在代码里的落点。

## 2.2 每一轮 superstep 做什么

一个 superstep 的实现可抽象为：

```text
tick() 选出本轮任务
  -> runner.tick()/atick() 并行执行任务
     -> 收集 writes（先不让同轮任务看到）
  -> loop.after_tick() 统一提交 writes
  -> (可选) checkpoint 持久化
```

源码旁注已经写明关键一致性语义：

- step N 的写入，在 step N+1 才可见
- step 内 channel 视图不可变
- 写入只在 step 边界应用

即 BSP（Bulk Synchronous Parallel）语义。

---

## 2.3 `stream()` / `astream()` 的分层职责

`stream/astream` 不是“只做输出”，而是完整 orchestrator：

1. `_defaults()`：把 config 和默认值归一化
2. 构建 callback/run manager
3. 创建 runtime（context/store/stream_writer）
4. 创建 loop + runner
5. 驱动 superstep 循环
6. 产出 stream 事件并在退出时给最终 output

### `_defaults()` 的工程价值

位置：`main.py:2337`

它把这些策略统一收口：

- recursion_limit
- output_keys
- stream/print modes
- checkpointer 来源
- store/cache 来源
- durability（`sync`/`async`/`exit`）

抽象原理：

> `_defaults()` 把“分散参数”折叠成“单一执行契约”，确保主循环逻辑稳定。

---

## 3. 状态系统原理（checkpoint + snapshot）

## 3.1 `get_state` 不是读内存变量

`get_state/aget_state` 做的是：

1. 从 checkpointer 读取 checkpoint tuple
2. `_prepare_state_snapshot` 重建 channels 与任务视图
3. 返回 `StateSnapshot(values, next, tasks, interrupts, ...)`

所以你拿到的是“可执行态快照”，不是单纯键值表。

---

## 3.2 `_prepare_state_snapshot` 的关键步骤

位置：`main.py:996`（异步版 `1115`）

```text
checkpoint tuple
  -> migrate old checkpoint if needed
  -> channels_from_checkpoint()
  -> prepare_next_tasks()
  -> apply pending writes
  -> assemble StateSnapshot(values/next/tasks/interrupts)
```

抽象原理：

- checkpoint 是历史事实
- snapshot 是当前可执行视图
- pending_writes 是两者之间的“桥”

---

## 3.3 state history 的价值

`get_state_history/aget_state_history` 基于 checkpointer 的 list/alist，逐个还原 snapshot。

这意味着：

- 可追踪每次状态推进
- 可做审计/回放/调试

前提：checkpointer 支持持久化。

---

## 4. 更新原理（`update_state` / `bulk_update_state`）

## 4.1 为什么要有 `bulk_update_state`

`update_state` 是单条更新包装。

真正核心是 `bulk_update_state`：它允许你按 superstep 批量应用更新，并保持与正常运行一致的写入语义。

---

## 4.2 `bulk_update_state` 内部其实在“模拟节点执行”

关键分支（同步异步同构）：

1. `as_node == END` 且 `values is None`
   - 清理当前任务上下文
2. `as_node == INPUT`
   - 把更新作为输入写入（走 input 写入路径）
3. `as_node == "__copy__"`
   - fork checkpoint（支持分叉后继续更新）
4. 普通节点更新
   - 找到 node writers，执行 writers，收集 writes
   - `apply_writes` -> `create_checkpoint` -> `put/aput`

你可以把它理解成：

> 不是“直接改状态字典”，而是“按 runtime 规则执行一次受控写入”。

---

## 4.3 task_id 复用为什么重要

`bulk_update_state` 会尽量复用 `prepare_next_tasks` 生成的 task_id。

意义：

- state history 里 task.result 能正确归属
- 回放/调试时轨迹一致

这是一种“可观察性一致性”设计，而不是性能优化。

---

## 5. interrupt/resume 原理

## 5.1 Pregel 如何表达 interrupt

`invoke/ainvoke` 在 `stream_mode="values"` 下会内部监听 `updates`，并把 `INTERRUPT` 聚合到返回值。

换言之：

- interrupt 不是异常退出协议
- interrupt 是状态流中的一种特殊更新

## 5.2 resume 如何接回执行

恢复时传入 `Command(resume=...)`。因为 checkpoint 保留了恢复所需上下文，图可继续推进。

抽象原理：

> interrupt 把“执行控制权”从 runtime 暂交给外部；resume 把控制权交回 runtime。

---

## 6. durability 的真实语义

`durability` 只在存在 checkpointer 时有效。

- `sync`：每步完成前同步落盘，最稳，吞吐最低
- `async`：下一步执行和持久化并行，常用默认
- `exit`：仅在图退出时落盘，吞吐好但崩溃恢复最弱

设计权衡是经典三角：

- 一致性 / 恢复能力
- 延迟
- 吞吐

---

## 7. 一眼看懂：Pregel 的 6 个不变量

1. **超步隔离不变量**：同一步内看不到本步新写入
2. **边界提交不变量**：写入只在 step 边界合并
3. **可恢复不变量**：interrupt/resume 必须依赖 checkpoint
4. **执行入口统一不变量**：`invoke/ainvoke` 最终都走 `stream/astream`
5. **状态可解释不变量**：`StateSnapshot` 同时描述 values + next tasks + interrupts
6. **更新一致性不变量**：`update_state` 必须复用 runtime writer 机制，而不是裸改状态

这 6 条抓住后，读任何 Pregel 细节都不会迷失。

---

## 8. 在 deepagents 项目里的落地映射

结合你项目：

- 会话主执行：`agent.astream(...)`
- 运行中观测：`agent.aget_state(...)`
- 取消/截断修复：`agent.aupdate_state(...)`
- HITL 恢复：`Command(resume=...)`

因此 `server/sessions.py` 的 run loop，本质就是 Pregel 异步超步引擎的上层编排层。

---

## 9. 最小示例（保留，但只用于验证概念）

### 9.1 最小超步运行

```python
from langgraph.channels import EphemeralValue
from langgraph.pregel import Pregel, NodeBuilder

node = NodeBuilder().subscribe_only("a").do(lambda x: x + x).write_to("b")

g = Pregel(
    nodes={"n": node},
    channels={"a": EphemeralValue(str), "b": EphemeralValue(str)},
    input_channels=["a"],
    output_channels=["b"],
)

print(g.invoke({"a": "foo"}))
# {'b': 'foofoo'}
```

### 9.2 interrupt/resume

```python
import uuid
from typing_extensions import TypedDict
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import StateGraph
from langgraph.constants import START
from langgraph.types import interrupt, Command

class S(TypedDict):
    x: str
    approved: str

def n(state: S):
    ok = interrupt("approve?")
    return {"approved": ok}

b = StateGraph(S)
b.add_node("n", n)
b.add_edge(START, "n")
graph = b.compile(checkpointer=InMemorySaver())

cfg = {"configurable": {"thread_id": str(uuid.uuid4())}}
print(list(graph.stream({"x": "hi"}, config=cfg)))
print(list(graph.stream(Command(resume="yes"), config=cfg)))
```

---

## 10. 如果继续深挖，按这个顺序读源码

1. `pregel/main.py`：外部 API 与主循环骨架
2. `pregel/_loop.py`：tick/after_tick/checkpoint 提交细节
3. `pregel/_runner.py`：并发执行、重试、写入回传
4. `pregel/_algo.py`：`prepare_next_tasks/apply_writes` 调度核心
5. `pregel/_checkpoint.py`：checkpoint 结构与复制/创建逻辑

这个顺序能把“结构 -> 执行 -> 调度 -> 持久化”串成一条线。
