# LangGraph Pregel 引擎深度解析

> 基于 `langgraph/pregel/main.py` 源码，从直觉到细节，让你彻底看透这个系统。

---

## 零、先讲个故事

想象一个**办公室**。

办公室墙上挂着几块**黑板**（**Channel**），旁边坐着几个员工（**Node**）。

规矩很简单：
1. 每个员工**盯着**特定的黑板。黑板上的内容一变，他就开始干活。
2. 干完活，把结果**写到**另一块（或同一块）黑板上。
3. 所有员工**同时干活**，但有个规矩：**这一轮别人写上去的东西，你看不到。要到下一轮才能看到。** 就像考试时不能抄旁边人的答案。
4. 每一轮结束后，主管（**Pregel**）统一把所有黑板内容更新，然后宣布："下一轮开始，看看谁盯的黑板变了。"
5. 当所有黑板都没有变化——没人被触发——**下班**。

为什么叫 Channel（通道）？因为信息**通过黑板从一个员工传到另一个员工**——黑板既是通道（信息流过的路径），也是存储（始终保留着当前值）。

这就是 Pregel 的全部。

下面我们把故事里的每个角色，对应到源码。

---

## 一、黑板 = Channel

Channel 就是一个**带规则的变量**。

什么规则？就是"当多个人同时往上写东西时，怎么合并"。不同的黑板有不同的擦写规则：

| Channel 类型 | 规则 | 生活类比 |
|-------------|------|---------|
| `LastValue` | 只保留最后写上去的 | 擦了重写——谁最后写，就显示谁的 |
| `EphemeralValue` | 每轮结束自动擦干净 | 便签——看完就扔 |
| `Topic(accumulate=True)` | 所有写上去的都攒着 | 越写越多，不擦 |
| `BinaryOperatorAggregate(int, add)` | 用一个公式持续累加 | 计数器——每次加上新的数 |

**这就是 StateGraph 里 "reducer" 的真面目。** 你写 `Annotated[list, operator.add]`，底层就是一个 `BinaryOperatorAggregate`。你写普通字段，底层就是 `LastValue`。

Channel 不是什么抽象概念，就是 State 的每一个字段。

---

## 二、员工 = Node

源码中叫 `PregelNode`（`_read.py` 第 95 行），每个员工有四样东西：

```
我盯着哪些黑板    → triggers     （哪些 channel 更新了我就干活）
我干活时读什么      → channels     （从哪些 channel 取输入数据）
我怎么干活         → bound        （执行逻辑：一个函数、一个 LLM、一条链）
我把结果放哪       → writers       （往哪些 channel 写输出）
```

用代码构建一个"员工"：

```python
worker = (
    NodeBuilder()
    .subscribe_only("收件箱")       # 盯着"收件箱"，有新邮件就干活
    .do(lambda mail: mail.upper())  # 干活：把邮件内容变大写
    .write_to("发件箱")             # 结果放进"发件箱"
)
```

三种"盯法"的区别：
- `subscribe_only("x")`：只盯一个黑板，拿到的就是上面写的值
- `subscribe_to("x", "y")`：盯多个黑板，拿到的是 `{"x": 值, "y": 值}` 字典
- `read_from("z")`：干活时顺便看一眼 z 黑板，但 z 有新东西时**不会**叫我起来干活

---

## 三、主管 = Pregel 类

主管负责：雇员工、摆黑板、吹哨开工、收工归档。

```python
class Pregel:
    nodes           # 所有员工
    channels        # 所有黑板
    input_channels  # 客户把需求写到哪块黑板
    output_channels # 最终从哪块黑板读结果交付
    checkpointer    # 归档柜（可选，用于存档/恢复/回溯）
```

### 主管第一天上班：`__init__`

（源码第 631-702 行）

```python
def __init__(self, *, nodes, channels, ...):
    # 1. 把设计图(NodeBuilder)变成真正的员工(PregelNode)
    self.nodes = {k: v.build() if isinstance(v, NodeBuilder) else v for k, v in nodes.items()}

    # 2. 偷偷加一个内部黑板，用于 Send 指令（动态派发任务）
    self.channels["__pregel_tasks"] = Topic(Send, accumulate=False)

    # 3. 验收：检查所有员工盯的黑板都存在
    self.validate()
```

验收时做了一件关键的事——**建索引**（第 3243 行）：

```python
# 黑板 → 盯着它的员工列表
trigger_to_nodes = {"收件箱": ["小王"], "state": ["小李", "小张"]}
```

有了这个索引，当某个黑板更新时，O(1) 就能找到该叫谁起来干活。

---

## 四、一天的工作流程

### 4.1 总流程

```
客户提交需求（invoke / stream）
  │
  ▼
主管把需求写到 input_channels 黑板上 ──→ 黑板内容变了
  │
  ▼
┌─── 第 1 轮 ───────────────────────────────────────┐
│  看哪些员工的黑板有新东西 → 叫他们起来           │
│  所有被叫到的员工同时干活（互相看不到对方的结果）    │
│  干完后，主管统一把结果写到对应黑板上              │
│  拍个照存档（checkpoint）                          │
└────────────────────────────────────────────────────┘
  │
  ▼
┌─── 第 2 轮 ───────────────────────────────────────┐
│  刚才有黑板被更新了 → 看谁在盯着这些黑板        │
│  叫他们起来，同时干活……                            │
└────────────────────────────────────────────────────┘
  │
  ▼
  ……重复……
  │
  ▼
所有黑板都没有新东西了 → 没人被触发 → 下班
  │
  ▼
主管从 output_channels 取出结果，交给客户
```

### 4.2 对应源码：invoke → stream → while loop

**invoke**（第 3024 行）就是 stream 的快捷方式——跑完全程，只拿最终结果：

```python
def invoke(self, input, ...):
    latest = None
    for chunk in self.stream(input, ...):   # 内部调 stream
        if mode == "values":
            latest = payload                # 不断覆盖，只留最后
    return latest
```

**stream**（第 2407 行）是真正干活的地方：

```python
def stream(self, input, ...):
    with SyncPregelLoop(input, ...) as loop:
        # __enter__ 做的事：
        #   加载存档（如果有）→ 恢复黑板内容 → 把 input 写到黑板上

        runner = PregelRunner(...)

        while loop.tick():                # tick = "看看还有没有人要干活"
            for _ in runner.tick(tasks):  # 并行执行所有被叫到的员工
                yield from stream.get()   # 边干边往外吐流式输出
            loop.after_tick()             # 归档 + 更新黑板
```

三个关键方法，各管一件事：

### 4.3 `loop.tick()` —— "还有人要干活吗？"

（`_loop.py` 第 459 行）

```python
def tick(self) -> bool:
    # 超过步数上限了？→ 收工
    if self.step > self.stop:
        return False

    # 遍历所有员工，看谁的黑板有新东西
    self.tasks = prepare_next_tasks(...)

    # 没人被触发？→ 收工
    if not self.tasks:
        return False

    return True   # 有活干，继续
```

**`prepare_next_tasks` 怎么判断"黑板有没有新东西"？** 靠两个数字：

```
channel_versions["state"] = 3
    ↑ 这个黑板总共被更新过 3 次

versions_seen["小王"]["state"] = 2
    ↑ 小王上次看到的版本是 2

3 > 2 → 有小王没看过的新东西 → 叫小王起来干活
3 == 3 → 小王已经看过最新的了 → 不叫
```

**这两个数字就是整个调度的全部秘密。** 没有什么复杂的图遍历算法，就是版本号比大小。

### 4.4 `runner.tick()` —— "大家一起干"

（`_runner.py`）

```
1. 把每个 task 扔进线程池
2. 等所有人干完（或超时）
3. 收集每个人的结果（写入了什么黑板、写了什么值）
4. 期间不断 yield，让外面能拿到流式输出
```

**关键规矩：这一轮里，A 员工写的东西，B 员工看不到。** 大家都在用"上一轮结束时"的黑板快照干活。这就是 BSP（Bulk Synchronous Parallel）模型——保证无论谁先干完，结果都一样。

### 4.5 `loop.after_tick()` —— "统一归档"

```
1. apply_writes(): 把所有人的结果统一写到黑板上
   → 调用每个 channel 的 update 方法（这就是 reducer 被执行的时刻！）
   → 更新 channel_versions（版本号+1）

2. create_checkpoint(): 给当前状态拍照

3. checkpointer.put(): 存进归档柜

4. step += 1: 轮次加一
```

---

## 五、跟着一个例子走一遍

```python
node1 = NodeBuilder().subscribe_only("a").do(lambda x: x + x).write_to("b")
node2 = NodeBuilder().subscribe_to("b").do(lambda x: x["b"] + "!").write_to("c")

app = Pregel(
    nodes={"node1": node1, "node2": node2},
    channels={"a": EphemeralValue(str), "b": LastValue(str), "c": EphemeralValue(str)},
    input_channels=["a"],
    output_channels=["b", "c"],
)

app.invoke({"a": "hi"})
```

```
初始化：
  客户需求 "hi" 写到黑板 a 上
  黑板版本：  a=1  b=0  c=0
  员工已读版本：node1 看 a=0，node2 看 b=0

第 1 轮 tick()：
  node1 盯着 a → a 版本 1 > 已读 0 → 起来干活!
  node2 盯着 b → b 版本 0 = 已读 0 → 继续睡
  → node1 拿到 "hi"，执行 "hi"+"hi" = "hihi"，写进 b

第 1 轮 after_tick()：
  apply_writes → b = "hihi"
  黑板版本：  a=1  b=2  c=0
  员工已读版本：node1 看 a=1，node2 看 b=0

第 2 轮 tick()：
  node1 盯着 a → a 版本 1 = 已读 1 → 没新东西，继续睡
  node2 盯着 b → b 版本 2 > 已读 0 → 起来干活!
  → node2 拿到 {"b": "hihi"}，执行 "hihi"+"!" = "hihi!"，写进 c

第 2 轮 after_tick()：
  apply_writes → c = "hihi!"
  黑板版本：  a=1  b=2  c=3
  员工已读版本：node1 看 a=1，node2 看 b=2

第 3 轮 tick()：
  node1 → a 没新东西 → 睡
  node2 → b 没新东西 → 睡
  → 没人被触发 → 返回 False → 下班!

输出：从 output_channels 取 b 和 c → {"b": "hihi", "c": "hihi!"}
```

---

## 六、循环是怎么回事

如果一个员工**盯着的黑板**和**写入的黑板**是同一个，那他就会不断触发自己：

```python
node = (
    NodeBuilder()
    .subscribe_only("value")
    .do(lambda x: x + x if len(x) < 10 else None)   # 长度够了就返回 None
    .write_to(ChannelWriteEntry("value", skip_none=True))  # None 时不写入
)
```

```
第 1 轮: "a"        → "aa"               写入 → 触发自己
第 2 轮: "aa"       → "aaaa"             写入 → 触发自己
第 3 轮: "aaaa"     → "aaaaaaaa"         写入 → 触发自己
第 4 轮: "aaaaaaaa" → None (len=16>=10)  不写入 → 黑板没更新 → 没人被触发 → 结束
```

**所以图的终止条件其实只有一个本质原因：没有黑板被更新了。** 其他情况（递归上限、interrupt）只是额外的刹车。

---

## 七、存档（Checkpoint）

每轮结束后，主管可以给办公室拍一张照片存起来。照片里记录了：

```python
Checkpoint = {
    "channel_values":   {"state": {...}, "input": None},    # 每块黑板上现在写着什么
    "channel_versions": {"state": 3, "input": 1},           # 每块黑板被更新过几次
    "versions_seen":    {"agent": {"state": 2}},            # 每个员工看到过哪个版本
}
```

有了这三样东西，就能**完整恢复任意一轮的现场**：
- 黑板上写着什么（数据）
- 黑板更新到第几版了（版本）
- 每个员工看到了哪些更新（进度）

这让你能做到：

| 能力 | 怎么做 |
|------|-------|
| **暂停/恢复** | interrupt 时存照片，恢复时读照片继续 |
| **时间旅行** | `get_state_history()` 翻看所有历史照片 |
| **分支** | 从某张照片 fork，走不同的路 |
| **手动改状态** | `update_state()` P 图后存为新照片 |

三种拍照频率（`durability`）：

```
"sync"  → 每轮拍完照才进入下一轮（最安全，最慢）
"async" → 边拍照边开始下一轮（默认，平衡）
"exit"  → 全部干完才拍一张（最快，但中途崩了就没了）
```

---

## 八、中断（Interrupt）—— 暂停等人审批

```python
Pregel(
    ...,
    interrupt_before_nodes=["人工审核"],   # 在"人工审核"员工开始干活前暂停
    interrupt_after_nodes=["AI分析"],      # 在"AI分析"员工干完活后暂停
)
```

流程就像：

```
AI分析员工干完了 → 主管喊停 → 拍照存档 → 把结果先给客户看
客户看完说"行，继续" → 主管读取照片恢复现场 → 继续下一轮
```

代码层面：
```python
# 暂停后的恢复
graph.invoke(
    Command(resume="用户批准了"),
    config={"configurable": {"thread_id": "会话ID"}}
)
```

---

## 九、Stream —— 边干活边往外吐

`stream()` 不等全部干完再给结果，而是一边干一边输出。不同模式看到不同粒度：

| 模式 | 你看到什么 | 类比 |
|------|-----------|------|
| `"values"` | 每轮完整的黑板状态 | 每轮拍一张办公室全景照 |
| `"updates"` | 每个员工这轮写了什么 | 看每个人的工作记录 |
| `"messages"` | LLM 逐字输出 | 看到 AI 一个字一个字地打 |
| `"custom"` | 员工主动汇报的任意信息 | 员工举手说"我这边进度 50%了" |
| `"debug"` | 所有细节 | 全程录像 |

---

## 十、update_state —— 手动在黑板上写东西

图暂停时，你可以手动修改某块黑板上的内容：

```python
graph.update_state(config, values={"messages": [新消息]}, as_node="agent")
```

内部会做什么？

```
1. 读取最近的存档照片
2. 恢复黑板内容
3. 找到 "agent" 员工的写入规则（writers）
4. 用这些规则处理你给的值（所以 reducer 会被执行！）
   比如 messages 是 list + append 的 reducer，那新消息会被追加而不是覆盖
5. 把更新后的状态存为新的照片
```

所以 `update_state` 不是无脑覆盖——**它会走一遍正常的写入流程**，包括 reducer。

---

## 十一、子图 —— 办公室里套办公室

一个员工可以自己管着一个小办公室（子图）：

```
总公司 (Pregel)
  └── 员工 "外包部门"
       └── 外包部门自己也是一个 Pregel，里面有自己的员工和黑板
```

子图的存档通过 namespace 隔离，不会和主图混在一起：`主图|外包部门:任务ID`。

---

## 十二、现在回过头看整体

```
Pregel 的本质：

    一间办公室
    几个黑板（Channel） —— 每个有自己的合并规则
    几个员工（Node）      —— 每个盯着特定的黑板
    一个主管（Pregel）     —— 吹哨、归档、判断是否收工
    一本相册（Checkpoint） —— 每轮拍照，支持恢复/回溯/分支

    每一轮：
      谁的黑板有新东西 → 叫他干活 → 结果写回黑板 → 拍照
      怎么判断"有新东西"？→ 版本号比大小，就这么简单

    什么时候结束？
      所有黑板都没有新东西了 → 没人被触发 → 自然收工
```

---

## 十三、对应源码位置

读源码时，这张表帮你定位：

| 你想了解的 | 去看哪里 |
|-----------|---------|
| Pregel 类定义、invoke、stream | `main.py` 第 324-3112 行 |
| NodeBuilder（构建员工） | `main.py` 第 160-321 行 |
| PregelNode（员工的数据结构） | `_read.py` 第 95 行 |
| tick()（该不该继续） | `_loop.py` 第 459 行 |
| prepare_next_tasks（版本号比较、决定触发谁） | `_algo.py` |
| apply_writes（执行 reducer、更新版本号） | `_algo.py` |
| PregelRunner（并行执行员工） | `_runner.py` |
| Channel 类型定义 | `channels/` 目录 |
| Checkpoint 创建和恢复 | `_checkpoint.py` |
| 图验证 | `_validate.py` |
| trigger_to_nodes 索引构建 | `main.py` 第 3243 行 `_trigger_to_nodes()` |

---

## 十四、最后一个洞察

Pregel 的名字来自 Google 2010 年的论文，专门用来处理大规模图计算。LangGraph 借用了它的核心思想，但做了一个关键简化：

Google Pregel 处理的是**数十亿个节点**的图（社交网络、网页链接），所以需要分布式。

LangGraph 的 Pregel 处理的是**几个到几十个节点**的 Agent 工作流，所以单机就够。

但核心模型完全一样：**节点通过消息通信，每轮同步一次，版本号驱动调度。**

这个模型之所以好用，是因为它把一个看起来很复杂的问题（"多个 Agent 协作执行"）变成了一个很简单的循环（"黑板有新东西吗？有就干活，没有就收工"）。

所有的花活——checkpoint、interrupt、stream、subgraph——都是往这个简单循环上加的功能。循环本身，从来没变过。
