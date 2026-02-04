
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

## 打开浏览器

- 输入: 打开google首页，提示:
  + 首次，则提示
    ![1769394090273](image/remark/1769394090273.png)
  + 启动My Browser连接器是manus内部逻辑，并不需要在用户手工启动
  + 点击安装，则安装Manus AI Browser Operator插件
  + 可不安装，使用manus虚拟机中的浏览器
  + 如果已安装，则提示授权，也可不授权，则使用默认虚拟机中的浏览器
    ![1769391433191](image/remark/1769391433191.png)

- 如果授权，则在当前浏览器中打开一个标签页
- 不授权，则在manus虚拟机机中打开chrome
  + 若需要输入账户，则提示需要接管
    ![1769391694409](image/remark/1769391694409.png)
  + 若需要输入密码，则提示强烈建议接管
  + 接管后，显示接管页面，下面可点击退出接管，并提示
    ![1769392015209](image/remark/1769392015209.png)
  + 告知manus接管期间做了什么，如没有输入，则默认为继续
  + 当然也可不接管，则存在信息泄漏的不安全因素


- 搜索boss上最新的AI岗位信息
  + manus 打开了boss，但一直卡住
  + 滑动校验时一起显示加载中

# genspark

## 打开浏览器

- 输入: 打开sina.com.cn，则使用Playwright在genspark client 打开了一个标签页面，而不是在sandbox中打开
  ![1769395179477](image/remark/1769395179477.png)
- 打开过程中，会不停的截图并分析
- 打开后，等待一段时间就自动关闭了，实测，基本不可用
  

# 建议：

- 教育场景目前Playwright操作，主要服务于搜索，而不是打开浏览器
- 可以打开浏览器，但是暂不进行用户交互，需要内部实现滚动, 打开内部连接等方便信息获取的方法
- 不过要实测

# DeepAgentsClient

- 一个页面对应一个DeepAgentsClient实例, 也对应一个websocket 连接
- 总实例数 = 打开的页面数
- 成员变量sessionId, wsUrl只记录当前chat
- 历史chat会记录在成员chatHistory

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

- 可能不需要导出来，生成过程中直接和用户交互，边做边修改

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
![1769407594469](image/remark/1769407594469.png)![1769407595635](image/remark/1769407595635.png)![1769407597837](image/remark/1769407597837.png)![1769407598039](image/remark/1769407598039.png)![1769407598221](image/remark/1769407598221.png)![1769407598419](image/remark/1769407598419.png)
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


# 进度安排

- 暂不完善历史记录方面的切换逻辑，先验证docker sandbox 在文件处理方面的一致性


# 路由

create_agent:
  graph.add_conditional_edges("tools", _make_tools_to_model_edge)
  graph.add_conditional_edges(loop_exit_node, _make_model_to_tools_edge)

_make_model_to_tools_edge -> Send('tools')

# 20260122 讨论

## pptx的写作难题

1. 套模板, 内容受限于模板，没有深度
2. html转pptx，格式信息丢失严重，目前没有很好的转换工具
3. nano bonano 采用图片，信息省略，文本表达能力不够
4. 模块化生成，先打造基本单元(可能是页面)，保证这些基本单元是完美的。生成时逐步确认(需求确认--大纲确认--再生成) (dokie)


## sandbox

1. manus用的是firecracker, 付费，和别人合作E2B，有一半的团队人员在做这个
2. 默认用的是daytona, 有免费额度，不够自由
3. 暂选型为docker，免费，自由，容易上手，比较主流

## 多模型 + 工具

1. 主线tool_call 目前用 glm-4.7，限速，建议尝试用claude
2. 工具类用其他模型，比如文生图或者图片理解用qwen-image
3. 代码生成用glm4.7
4. 共识，agent场景下，主要的还是用claude，要尝试


## 如何稳定使用海外模型api

1. 暂定使用wildcard


# 20260126

1. 修改ui，颜色，字体，logo
2. 运行上传图片
3. 添加图片理解，图片生成


# 20260127

1. 添加playwright, 尝试在boss中进行搜索， 页面滚动等
2. 主要针对教育场景

# 20260128

1. agent browser， 最新的，有skills，比较省token，但试用后发现playwright 与 chrome 版本不一致，试了几次都不行
2. playwright, 用的最多，有90k star，支持chromium，webkit，firefox, 风评比较好，暂定选择
  - 成功打开，并scroll
  - 建议使用，同时使用确定好的网站，在skill 中写好登陆信息，比如固定的几个招聘网站，在宿主主机中打开，并使用复用的方式
  - 缺点：用户无法看到打开的网站，固定的几个网站
3. chrome-devtools-mcp, 官方，比较火，有skills
  - 成功打开，但是没有scroll
 
# 20260119

1. 参考 crawl4ai (风评比较好, manus 推荐)
2. 内部封装了playwright
3. ExpectedGain(link) = Relevance (BM25) × Novelty × Authority (对链接进行多维度打分)
   但好像是说不支持qury，那么BM25是如何计算的？
4. 对LLM友好，指结果友好，而不是需要用LLM进行解析
5. 49 上命令行可以成功，macos不行，可能与playwright 与chrome有关
6. 网络搜索建议先用 coze，这是一个大工程
7. 可先接入图片等， 以及需求
8. 建议先专有搜索
9. manus 自己回答用的是用模拟点击
10. vlm返回的结果不对，找不到链接，考虑使用LLM, 反正内容已经取到


爬虫和浏览器自动化是两个需求，前者侧重获取数据，后者侧重在特定操作，完成任务

# 20260130

1. https://www.zhipin.com/hangzhou/?seoRefer=index 的反爬，playwright会自动打开blank，genspark 也一样，导致反复打开
2. manus使用用户端chrome能够打开，可能使用了不同的技术，比如客户端插件。
3. manus使用默认浏览器也会出现blank，但是最后会稳定

4. 有一种方式可以稳定的打开boss

5. chrome extensions 跨平台，免编译，但是存在翻墙问题

打开本地浏览器

``` 
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome 
--remote-debugging-port=9222 
--user-data-dir="/Users/double/vsproject/deepagents/workspace/cdp_profile"
```

curl http://127.0.0.1:9222/json/version
获取webSocketDebuggerUrl

{
   "Browser": "Chrome/144.0.7559.110",
   "Protocol-Version": "1.3",
   "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
   "V8-Version": "14.4.258.23",
   "WebKit-Version": "537.36 (@cfecec24a8e1b3d5f3b58e52f11d1327ac1534c0)",
   "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/03d0aa0c-c7ae-4021-9efd-fd73bd83f561"
}

playwright 连接此chrome

```
PLAYWRIGHT_OPEN_ONLY=1 \
PLAYWRIGHT_CDP_URL="ws://127.0.0.1:9222/devtools/browser/03d0aa0c-c7ae-4021-9efd-fd73bd83f561" \
pytest -k test_playwright_open_only_cdp test/test_playwright_vlm_click.py



```

有一种方式可以稳定的打开boss

打开本地浏览器
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome 
--remote-debugging-port=9222 
--user-data-dir="/Users/double/vsproject/deepagents/workspace/cdp_profile"

curl http://127.0.0.1:9222/json/version
获取webSocketDebuggerUrl

{
   "Browser": "Chrome/144.0.7559.110",
   "Protocol-Version": "1.3",
   "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
   "V8-Version": "14.4.258.23",
   "WebKit-Version": "537.36 (@cfecec24a8e1b3d5f3b58e52f11d1327ac1534c0)",
   "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/03d0aa0c-c7ae-4021-9efd-fd73bd83f561"
}

playwright 连接此chrome
PLAYWRIGHT_OPEN_ONLY=1 \
PLAYWRIGHT_CDP_URL="ws://127.0.0.1:9222/devtools/browser/03d0aa0c-c7ae-4021-9efd-fd73bd83f561" \
pytest -k test_playwright_open_only_cdp test/test_playwright_vlm_click.py


以上是一种可靠的反爬打开网站的方式，针对上面的用法，考虑如何在当前项目中集成，要求如下：

- 不是一个测试程序，抛开crawl 和 test目录，考虑在当前deepagents项目中集成，相关代码在web 和 server中
- 要打开用户的浏览器，而不是在服务器上打开浏览器
- 要能够获取用户浏览器中的内容，并发送到服务端
- 服务端接收当前页面的信息，并结合用户query，一起交给llm 进行下一步浏览器操作，比如滚动页面，点击按钮，打开新链接
- 回传给server的数据要精简，但是要能满足llm分析，并能产生回应操控浏览器
- 使用Chrome 扩展（0 本地依赖），通过加载未打包的应用程序来加载

实际上要做的是：依据用户输入，在客户端模拟浏览器操作，进行针对性搜索，直到满足要求

给出具体的实现流程，和技术说明

```

# 20260202

1. boss 有很强的反爬措施，比如 打开 https://www.zhipin.com/web/geek/jobs?city=101210100&stage=803,805&query=llm 后源码无法看到页面内容
2. 如 融资阶段 这类弹出式信息无法查看，导致无法进行下一步点击
3. 默认manus打开后出现问题会调用baidu
4. manus: 已尝试多次点击融资阶段筛选器，未找到“C轮”。下一步考虑刷新页面或手动搜索筛选。
5. genspark: 很抱歉，我目前遇到了技术问题，无法直接控制浏览器来完成你要求的操作。浏览器自动化工具暂时无法连接。

6. 后面可以考虑 playwright,coze,baidu,google 混合着来

7. 会议结论，暂不考虑导出可编辑的pptx


# 20260203

## 添加文件上传功能
```
在输入框中增加上传附件的功能：
1. 输入框中增加附件按钮
2. 点击附件，打开文件管理器，选择文件上传
3. 上传的文件需要和session绑定，下载到对应session的docker中
4. 解析上传文件的内容，并添加到context中

依据上面的需求，说出你的理解，并制定修改计划

支持的文件类型与大小限制？
暂不限制大小，支持的类型为图片，文本文件，pdf，docx，excel

解析方式（只取纯文本，还是支持 PDF/DOCX/图片 OCR）？
所有类型的文件，调用不同的工具提取为文本，图片需要调用图片理解工具，其他文件内容提取有针对性的skill或者tool，
这个调用在agent运行过程中由llm来判断，并自动调用

文件应写入容器内路径还是宿主机挂载卷路径（已有约定吗）？
与当前agent运行过程中生成的文件相同，要求在docker中可访问，并挂载到宿主主机中

context 中如何呈现：完整文本还是摘要/分块？
完整文本，暂沿用当前已有的文本压缩逻辑

2. 输入窗口上传文件后，如果为图片，显示略缩图，如果为其他文件显示图标和文件名，图标右上角显示删除的图标，可点击删除上传的文件

3. server启动时添加日志，显示项目运行的环境
4. 初始化session后创建agent时，显示当前agent绑定的tool，skill，model

增加用户，当前为xh1---xh4, 增加到xh10，用户名和密码相同
历史记录中显示的标题信息不要为用户第一次输入内容截取的前面几个字，而是对用户内容的概括

修改 tool 中 'qwen_image_understand', 'qwen_image_generate' 这两个名称，要求在输入 解释这个图，对图片进行说明，提取图片内容等内容时，能够稳定的调用对应qwen_image_understand对应的工具， 而要求进行文生图时，能够稳定的调用qwen_image_generate 对应的工具

页面下面的对话框分成二部分：
1. 上面为输入部分，下面有一栏，包括附件和发送
2. 在输入框中有附件时，用户的输入要在附件的下面，不要被附件遮盖
3. 点击发送后，附件显示在用户输入侧的对话列表中，在对话框中清除图片信息
4. 输入框中上传的附件整体框变小一点
```

J18R5S81SEJAX34H

# 20260204

1. 日志中不要流式打印, 只需要在收到完整的包时，全量打印，如下面的流式日志要改进
2026-02-03 22:57:42,964 INFO deepagents_server sessions.py:494 - LLM message: session_id=4dae9bf869594ed99cf3fddf05dbcad2 run_id=ml6q2p89h3l3df4q0c text=让我
2026-02-03 22:57:42,964 INFO deepagents_server sessions.py:494 - LLM message: session_id=4dae9bf869594ed99cf3fddf05dbcad2 run_id=ml6q2p89h3l3df4q0c text=检查
2026-02-03 22:57:42,965 INFO deepagents_server sessions.py:494 - LLM message: session_id=4dae9bf869594ed99cf3fddf05dbcad2 run_id=ml6q2p89h3l3df4q0c text=文件
2026-02-03 22:57:43,202 INFO deepagents_server sessions.py:494 - LLM message: session_id=4dae9bf869594ed99cf3fddf05dbcad2 run_id=ml6q2p89h3l3df4q0c text=状态

2. 时间信息显示优化

data/users/xxx 目录下chat_history.json 中 createdAt 和 timestamp 分别是什么含义？
建议用更明显的key表示，时间戳换成可读的时间字符串


web中打开172.16.2.4 中运行时，连接的服务端为何是172.16.2.49, 应该连接本机
-- 主要是vsproject自动添加ports forward，将2.4转到2.49上, 需要删除

历史记录中信息条目，点击时无法展开，


删除config/model.yml 中关于 langchain_project 的配置，修改为按照不同的会话进行配置，将其值修改为sessionid，既不同的会话有不同的日记轨迹

