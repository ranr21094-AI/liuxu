# 全库结构审查（2026-09-30）

范围：server/database、lib 下的数据/知识/Agent/电脑/远程/HTTP 模块、Electron、Chrome 扩展、前端、构建脚本与测试。生成的 vendor 和安装包不作为手写源码审查。通过模块静态扫描、关键调用链检查和回归测试核实；不等同于逐行形式化验证。保留审查前已有的查找、阅读位置及其他未提交改动。

## 结论

主要问题是生命周期、异步请求和写入副作用分散，已经导致保存、恢复和会话状态上的实际缺陷。更换 Express/SQLite 或一次性迁移前端框架不能直接解决这些问题。优先按业务拆控制器与服务，明确每个模块的启动、取消、停止及状态归属。

审查开始时 workbench.js 约 6,328 行、server.js 3,796 行、database.js 2,327 行；三处同时承担多类业务。文件长度本身不是缺陷，但这些文件的共享状态和隐式初始化使独立测试、请求取消与安全写入难以统一。

## 本轮已修复

| 问题 | 处理及验证 |
| --- | --- |
| 自动保存冲突与外部同步重复实现草稿保存，忽略 HTTP/网络失败后覆盖输入 | 共用 persistConflictDraft，必须确认返回草稿 ID；失败、保存期间继续编辑及迟到响应均保留输入。conflict-draft-ui 测试覆盖 409/500/断网等路径。 |
| 外部删除正在编辑的笔记直接清空编辑器 | 未保存输入保留为冲突状态；日记锁定继续隐藏私密内容。 |
| JSON/ZIP 恢复重复收尾，关联清理发生漂移 | 抽出 lib/workspace/restore-effects.js，统一缓存、迁移、远程会话、浏览器标签和阅读位置清理；测试两种 JSON 入口及 merge 保留行为。 |
| 在线数据库 ZIP 导出只 checkpoint 后打包活动 DB | 改用 SQLite backup API 生成快照，兼容知识/Agent JSON 从同一快照生成。附件与外部文件仍不具备跨文件系统的单时点快照保证。 |
| ZIP merge 可沿目的目录符号链接写出根目录，失败后文件未回滚 | 检查逐级目录和目标文件，记录新建文件/目录并回滚；数据库合并阶段禁止提前同步写盘。备份测试覆盖逃逸和部分安装回滚。 |
| 临时知识服务隐式启动 watcher | 增加 startFolderSync 参数；导出/合并临时服务不启动后台监听。 |
| 档案预览读取同步路径缺少真实路径边界检查 | filePathFor 统一经过真实路径和符号链接检查。 |
| Chrome 扩展未配对仍接受命令 | 未配置密钥拒绝执行，配对签名继续验证，并在当前扩展 worker 内去重 nonce。worker 重启后的持久化防重放仍属后续增强。 |
| 重启遗留执行态 run 永久阻塞新任务 | queued/running/waiting_client_tool 标为失败并记录中断原因，不重放操作；审批/问答等待保留可续答。 |
| 系统打开 IPC 接受任意目录内路径，绕过文档授权 | 改为文档 ID，由主进程携带当前日记 Cookie 调用受保护 location 接口。 |
| PDF/PPT cleanup 覆盖通用 abort，重试漏传阅读位置回调 | 统一通过 AbortController 清理；重试重新建立完整阅读器生命周期。 |
| 无版本化 JS/CSS URL 缓存一天，升级可能继续运行旧界面 | JS/MJS/CSS 改为每次重验证。 |

## 仍需处理的具体发现

### P1：批注加载/保存可覆盖后续输入

public/js/workbench.js 的 loadFileAnnotation / saveFileAnnotation（约 4884/4905）在请求前捕获草稿；响应回来后未比较最新草稿。保存响应还可在切换档案后更新当前表单并清理旧草稿。建议提取按 documentId 管理的 AnnotationController，保存请求绑定内容快照，成功只清除与提交内容一致的草稿，失败和迟到响应不触碰其他档案。

### P1：文件删除及图片移动的同步边界不完整

lib/knowledge/folder-sync.js prepareWrite（约 418）仅在旧文件存在时检查指纹；外部刚删除而扫描未到达时，保存可能复活文件。copyRelativeImages / copyLegacyImages 遇目标同名图片直接跳过，笔记移动后可能引用不同图片。建议将不存在纳入指纹冲突；资源复制按内容哈希判断同名，冲突时生成新名称并只重写真实图片 token。

### P2：列表请求缺少统一的响应归属检查

public/js/workbench.js loadDocuments（约 4677）没有请求 generation 或取消控制器。连续搜索、切换文件夹时旧响应可能覆盖新列表。建议由 KnowledgeListController 持有查询快照、generation 和 AbortController，分页请求同时绑定查询快照。

### P2：浏览器标签恢复与异步操作依赖可变全局文档

public/js/knowledge/note-browser.js hydrateDocument（128）在循环完成前标记 hydrated，中途切笔记会留下不完整恢复；openTab（103）和 closeTab（154）在 await 后使用当前文档记录。建议所有操作捕获 documentId，按该文档更新记录；恢复成功后才提交 hydrated 状态，并允许失败重试。

### P2：笔记助手首次加载失败无法正常重试

public/js/knowledge/note-assistant.js（约 991）先设 sessionLoaded，再异步加载；失败清 sessionId 但不复位 sessionLoaded。建议使用 idle/loading/loaded/error 状态并绑定文档 generation。

## 结构重构顺序

1. **前端知识控制器**：先抽笔记保存/冲突、批注和知识列表，再抽模型设置与 Agent 会话。workbench 只保留路由、组合模块和页面启动。每个控制器显式持有自己的状态、请求标识和 destroy 方法。
2. **应用初始化**：server.js 提供 createApp({db, services, config}) 与显式 start/dispose；database.js 的默认实例兼容入口与 createDatabase 工厂分开。当前导入 server 即初始化数据库、迁移和定时器，进程锁晚于这些写操作；测试必须修改环境并清 require 缓存。先分离初始化，随后才能安全并行测试。
3. **按业务拆接口**：将旧 logs 兼容、待办/倒数日、邮件提醒、模型供应商设置分别注册为 router；保留明确路由顺序。避免通过一个包含二十多个闭包的大 ctx 把所有能力重新耦合。
4. **同步服务唯一归属**：知识服务构造与 watcher 启动彻底分离；由工作区生命周期管理唯一实例。导入、备份、迁移使用无后台任务的服务视图。
5. **公共协议与渲染**：主 Agent 和笔记助手共享事件去重、终态处理、工具/图片/审批数据模型；视图差异放在薄适配器中，避免各自维护近似状态机。
6. **测试组织**：把 risk-hardening 的通用临时数据库/HTTP/环境 fixture 移到专用 helper，并用行为测试逐步替换源码正则断言。两个 Electron fixture 启动脚本可共用 runner，平台打包流程继续保持平台差异。

这些步骤可逐个落地；每步保留接口和数据格式，先有跨边界行为测试，再移动实现。当前证据不足以支持一次性更换前端框架或数据库。

## 验证记录

模块回归覆盖草稿保护、恢复清理、Agent 重启、扩展签名、知识目录及 ZIP 恢复。完整 npm test：455 项，454 通过、0 失败、1 项平台相关跳过；另补的系统打开授权测试通过。本机端口测试在允许 loopback 的环境完成。实际安装应用和真实知识目录未用于破坏性测试；本轮不构建安装包。
