
# manus

1. 先生成了md
2. md 转 pdf
3. md通过LLM生成html
4. 而pptx是另外生成的，不是html转pptx

## 技术方案: 每一页先生成了html,再通过工具内部转为pptx

- 其中一次看的结果
- 存在如下问题：
  1. 页面不统一，包括背景，配色
  2. 内容不统一，其实就量插入图片和文字，如图片的背景色
  3. 文本框内容不协调，包括字体的位置，溢出等

- 应该是html转pptx时效果无法保证
- 而html生成pdf时效果要好

```
ubuntu@sandbox:~ $ manus-export-slides manus-slides://kZdSk89cZLOYihfk3Nr2Jc pdf && manus-export-slides manus-slides://kZdSk89cZLOYihfk3Nr2Jc pptx
Starting conversion: manus-slides://kZdSk89cZLOYihfk3Nr2Jc -> PDF
Slides URI: manus-slides://kZdSk89cZLOYihfk3Nr2Jc
Version ID: kZdSk89cZLOYihfk3Nr2Jc
Export format: PDF
Output file: 2025-2026_A.pdf
Generated file: 2025-2026_A.pdf
Conversion completed
Starting conversion: manus-slides://kZdSk89cZLOYihfk3Nr2Jc -> PPTX
Slides URI: manus-slides://kZdSk89cZLOYihfk3Nr2Jc
Version ID: kZdSk89cZLOYihfk3Nr2Jc
Export format: PPTX
Output file: 2025-2026_A.pptx
```

# DeepAgentsClient

- 一个页面对应一个DeepAgentsClient实例
- 总实例数 = 打开的页面数
- 成员变量sessionId, wsUrl只记录当前chat
- 历史chat会记录在成员chatHistory中

# session

- 创建新页面时会生成session, 生成新对话时也会生成session
- 如果init 后并不发送消息，多次点击newChat，会产生多个孤立的session
  + 加了优化，如果当前会话是空白会话，则复用
- 一个sessionid对应一个wsUrl = ws/session.id
- 先简单的理解: 一个chat对应一个session

# runId

- 用户每发送一次消息对应一个runId

# task

- client 的runId对应服务端的run_id，对应一个执行task


# doubao 生成ppt流程

## 输入: 深度调研A股近期走势，生成精美的pptx

## 过程

- 了解现状, 做一些搜索
- 制定计划，md大纲文件
- 视觉效果, 图像生成，背景图和抽象概念图，图片搜索
- 收集素材和完善计划
- 开始写ppt，md->ppt，为每张pptx设计提示词

## ppt制作

- PPT 整体要求

  - 设计原则
    - 设计风格（主题，深色科技风，结果说明：需要封面、目录、过渡页和致谢页）
    - 全局一致性规范(页面大小，字体，边距，色彩)
    - 其他要求：丰富，可读

  - 分页设计方案
    - 每个页面有不同的定位：封面，目录，过渡页，内容页，致谢页
    - 不同类型的页面如何背景图:
      - 封面

        生成任务：生成一张 16:9 的图，深色科技风格，底色是深暗蓝色，画面上有抽象的金融数据图表和发光的线条，画面中间 2/3 区域要是干净无元素的。
      - 目录

        生成任务：生成一张 16:9 的图，深色科技风格，底色是深暗蓝色，画面左侧有垂直的、发光的几何线条作为装饰，画面整体保持简洁。

      - 过渡页使用相同的文生图prompt 

        生成任务：生成一张 16:9 的图，深色科技风格，底色是深暗蓝色，画面中央有一个发光的圆形或方形科技感图案，图案周围有光晕效果。

      - 内容页面

        + 各页面使用不同的文生图prompt，有些页面没有图
        + 如果当前页面内容较多，则不生成背景图，有数据则在右侧生成数据图


  - 具体执行
    - 分批生成图片
      + 先是背景图
      + 相似的图片请求组合在一起
      + 第一批请求包括: 封面、目录、章节过渡页以及 “宏观政策” 和 “资金面” 页面的背景

    - 使用字符串替换功能将生成的图片链接替换到占位符


# GenSpark

- 每页分别先生成html代码，可以看到每页的html内容

# pptxgen (通过pptxgenjs生成的)

- 当前使用这个方案
- 效果图 -> codex -> 生成模板 (包括template.js 和 data.json，最复杂的让gpt5.2做)
- inputs.md -> 选择模板 -> 拆分为 slide.json -> 转pptx -> 合并
- 优点是可控，可以不停的加模板
- 可以进一上的工程化

# html2pptx ()

# pptx (claude 原skill)

# sandbox (daytona)

- 远程执行通过 `--sandbox daytona` 启用，底层走 `DaytonaBackend` 调用 `sandbox.process.exec(command)` 执行命令字符串（非交互式 shell）。
- 系统类型在 CLI 提示中统一描述为 Linux sandbox，默认工作目录为 `/home/daytona`。
- 依赖保障不是自动的：代码里假设沙盒内有 `bash`、`python3`、`grep` 等基础命令（`BaseSandbox` 的文件操作依赖它们）。
- 需要的命令用 `--sandbox-setup` 在沙盒创建后一次性安装，避免执行中途因缺命令失败。

# sandbox (docker)

- 服务端以 docker 容器作为 sandbox 后端，镜像基于 ubuntu22.04，预装 python3/pip/uv/apt/vim/node。
- 每个 session 对应 `workspace/<session_id>/` 子目录；删除 session 时从容器 `/workspace` 同步回写到该目录。
- docker 实例采用预热池机制：默认保持 10 个空闲容器，空闲少于 2 自动补齐。
- 释放策略：仅在用户点击 Web 删除按钮时释放容器并回传数据，不在断开 ws 时自动释放。

# docker 启动时机

- deepagents_server.py启动的时候会通过lifespan注入DockerSandboxPool，用于生成10个容器
- 

## 结论

- 暂定用docker, 可控，免费，可提前装包，要留意速度和资源消耗
- daytona，好集成，系统有此选项，但要付费，提前装包等这些定制需求不了解
