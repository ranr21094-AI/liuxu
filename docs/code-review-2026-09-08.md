# 全仓库代码审查与修复交付 — 2026-09-08

## 修复交付（2026-09-08）

本轮 9 项均已处理。第 7 项按用户确认的方向扩展为完整笔记 Agent；操作确认、目录白名单、日记权限和单层委派规则保留。初次修复交付保留已有布局改动，未构建安装包。随后用户要求发布 v1.3.0，发布范围包含上述修复及已有布局改进；安装包与签名方式见 `docs/releases/v1.3.0.md`。

| 项目 | 已实现 | 回归验证 |
| --- | --- | --- |
| 1 自动保存 | 按文档等待请求、排空后续修改，失败/冲突阻止切换 | 延迟请求、二次输入、版本递增、500/409 保留输入 |
| 2 旧 ZIP | 临时库校验并完整导入后替换；失败回滚 | 空目录及过时 JSON 目录一致，损坏结构拒绝，附件安装中断回滚 |
| 3 扩展验签 | 密钥字符串按 UTF-8，签名按十六进制 | 真实扩展函数验证服务端签名，篡改参数/签名失败 |
| 4 大型备份 | SQLite 为权威，兼容 JSON 不受旧 10 MiB 解析限额阻断；导出同步限额 | 22 篇 × 490,000 字符导出后替换/合并；超限附件导出失败 |
| 5 搜索失效 | 替换前移除磁盘索引，提交/回滚均清理知识及 Agent 缓存 | 相同索引版本不同内容，旧词无结果、新词可命中 |
| 6 子任务恢复 | 单一父任务续跑入口，终态与完成消费防重复 | 连续两次提问，父子模型调用/完成事件各一次；现有拒绝/取消回归 |
| 7 完整笔记 Agent | 全工具及依赖、正常预算、绑定文档委派、审批/提问/浏览器/记忆/图片；原始 baseVersion 确认写入 | 独立 HTTP 启动、原 run 续答、未知工具拒绝、过期版本、成功写入、子任务继承及事件回传 |
| 8 文件批注 | 父文件位置/权限同步批注版本及索引，读取检查父文件，标记私密图片 | 移入日记后父文件/批注不可读，图片私密标记生效 |
| 9 待办错误 | 所有请求检查状态，失败不走成功路径 | HTTP 400/404/500 均保留表单并显示错误 |

### 最终验证

- 模块回归：27 项全部通过（备份、审查回归、笔记助手模拟界面）。
- 完整 `npm test`：379 项，378 通过，0 失败，1 项 Windows 路径大小写测试在当前平台跳过。最终运行显式设置隔离的 `DATA_DIR` 和密钥路径。
- JSDOM + 模拟 HTTP/SSE：草稿保存失败保留审批；等待回答保留 runId；浏览器重放只转发一次；记忆与子任务状态展示；保存后锁定、成功刷新、失败保留草稿、删除/归档退出、断线等待重连。
- 真实扩展验签函数在 Node WebCrypto 中执行；没有连接真实 Chrome 扩展、调用付费模型或执行真实电脑/生图操作。安装包端到端测试不在本轮范围。
- `git diff --check` 通过。测试中的 ES module 类型提示为现有警告，不影响结果。
- 测试源码：`test/review-regressions.test.js`、`test/note-assistant.test.js`、`test/note-assistant-ui.test.js`；既有 Agent、备份和权限测试同时通过。
- 原始日志位于 `/tmp/liuxu-delivery-modules.log`、`/tmp/liuxu-delivery-isolated-test.log`，临时文件可能被系统清理。

## 修复前的审查记录

以下问题描述、行号和基线结果对应修复前快照，用于保留审查依据；不表示这些问题仍然存在。

基于 `a93f1aa` 及当前工作区。确认 9 项新的功能问题：3 项 P1、6 项 P2。P1 建议优先修复，P2 应安排修复。上一轮指出的特殊消息卡片留白问题仍存在，属于额外的 P3 显示问题。

本次按完整仓库范围审查后端接口、SQLite 与迁移、知识库和备份、Agent 与模型适配、电脑工具及 Chrome 扩展、Electron 启动/更新、前端保存和交互、构建配置及测试；没有将范围限制在未提交差异。使用静态阅读、现有测试和针对性隔离复现，不代表每个分支都经过真实用户界面操作。未调用真实模型、发送邮件或执行安装更新；Windows 安装和真实扩展通信未做端到端验证。既有文档中明确暂缓的问题未重复计为新发现。

## 验证结果

- `npm test`：358 项，357 通过、0 失败、1 跳过。跳过项为 Windows 路径大小写测试。
- 首次测试受到沙盒本机端口限制；允许本机测试监听后重新执行，得到上述结果。
- 9 项发现均以临时数据或模拟请求复现。数据库、文件及配对密钥均为测试样本；没有读写用户生产数据。
- 复现脚本：[liuxu-full-review-repro.cjs](/tmp/liuxu-full-review-repro.cjs)；输出：[复现结果](/tmp/liuxu-full-review-repro-results.json)。这两个文件位于临时目录。
- 初次审查阶段没有修改业务代码或既有测试；后续修复见上方交付记录。

## 1. [P1] 切换笔记时，等待中的自动保存被当作已经完成

位置：[workbench.js:4683](/Users/ranran/Documents/ChatGPT/liuxu/public/js/workbench.js:4683)。关联路由检查：同文件 876 行。

触发：笔记 A 的第一次自动保存尚未返回，用户继续输入，然后立即切换到笔记 B。

`saveDocument()` 在 `state.savingDocument` 为真时只安排定时重试，却立即返回 `true`。`flushPendingSaves()` 把它作为成功结果返回，允许路由切换；打开 B 会清空 A 的 dirty 状态和保存定时器。A 的请求随后返回时又因 activeDocument 已改变而提前退出，第二次输入没有机会提交。

复现：模拟首次请求未完成，在第二次编辑后调用 flush，结果为 `true`；完成切换和请求后，服务端只收到 `first edit`，`second edit` 从未提交。

建议：按文档跟踪保存中的 Promise；flush 应等待请求完成，并继续提交该文档尚未保存的改动，全部完成后才允许离开。

## 2. [P1] 旧格式 ZIP 恢复成功后，刚恢复的结构数据被删除

位置：[zip.js:400](/Users/ranran/Documents/ChatGPT/liuxu/lib/workspace/zip.js:400)。

触发：替换恢复不包含 `schedule.db` 的旧版 ZIP，待办、分类等位于 `workspace.json`。

函数先通过 `db.restore(data, mode)` 把结构数据写进 SQLite，随后删除整个 `schedule.db`，再调用 `importJsonAccount()` 从散落的 JSON 文件重建。前一步恢复的数据没有同步写成 `todos.json` 等文件，因此重建得到空值或旧目录里残留的过时数据。返回值仍然来自删除前的恢复操作，界面显示成功。

复现：ZIP 中包含 1 条待办；返回 `success: true, todos: 1`，恢复完成后实际待办数量为 `0`。

建议：把旧 ZIP 中的各部分统一导入同一个 SQLite 事务，或先完整构建并验证暂存数据库；不要删除已经装入正确结构数据的数据库后再依赖旧 JSON 重建。

## 3. [P1] 扩展和服务端使用不同的 HMAC 密钥字节，配对后命令验签失败

位置：[background.js:63](/Users/ranran/Documents/ChatGPT/liuxu/chrome-extension/background.js:63)。服务端：[chrome.js:13](/Users/ranran/Documents/ChatGPT/liuxu/lib/computer/chrome.js:13)。

服务端生成 64 位十六进制字符串，并直接把字符串传给 `createHmac()`，实际使用 64 字节 UTF-8 文本作为密钥。扩展的 `hexToBytes(stored)` 将同一个值解码成 32 字节，再交给 Web Crypto。两端虽然保存相同字符串，计算出的 HMAC 不同。

复现：用真实服务端 `sign()` 签名，再调用从扩展源码提取的 `verifyAgentCommand()` 验证；使用相同测试密钥、nonce、name 和 args，结果仍为 `false`。

建议：统一密钥编码，并添加服务端签名、扩展验证的跨端测试。兼容已配对密钥时，明确保留或迁移既有编码约定。

## 4. [P2] 当前版本导出的较大 ZIP 无法由当前版本恢复

位置：[zip.js:275](/Users/ranran/Documents/ChatGPT/liuxu/lib/workspace/zip.js:275)。

导出没有相应大小限制，恢复却要求每个兼容 JSON 不超过 10 MiB。即使 ZIP 已有完整且有效的 SQLite 数据库，恢复仍首先解析并限制 `knowledge-documents.json` 和 Agent JSON。正常积累的笔记、附件提取文本或较长工具输出就能超过这一门槛。

复现：通过知识服务正常创建 22 条、每条 490,000 字符的笔记。导出得到约 57 KB 的有效压缩包，再恢复时直接报 `knowledge-documents.json is too large`。

建议：为 SQLite ZIP 和旧 JSON ZIP 分开验证；SQLite 恢复不应被冗余兼容 JSON 的较小上限阻断。统一导出、上传、解压和数据库大小限制，并增加自产备份往返测试。

## 5. [P2] ZIP 替换恢复后可能继续使用恢复前的搜索索引

位置：[search.js:142](/Users/ranran/Documents/ChatGPT/liuxu/lib/knowledge/search.js:142)。恢复收尾：[zip.js:342](/Users/ranran/Documents/ChatGPT/liuxu/lib/workspace/zip.js:342)。

磁盘索引只以 `knowledge_index_state.version` 数值加权限标记作为签名。替换恢复保留目标目录原来的 `knowledge-index.json`；接口清理了内存中的知识服务，但没有删除磁盘索引。两个不同数据库恰好有相同 version 时，新的服务直接加载旧索引。

复现：目标数据库只有 OLDORANGE，源备份只有 NEWBANANA，两边版本号相同。恢复后文档标题正确变成 NEWBANANA，但搜索 NEWBANANA 得到 0 条；搜索 OLDORANGE 却得到标题 NEWBANANA、摘要 OLDORANGE 的结果。

建议：替换数据库后删除或强制重建派生搜索索引；若保留缓存，签名应包含数据库身份或恢复世代，避免不同数据库共享相同版本号。

## 6. [P2] 回答子任务问题后，已经完成的父子任务再次执行

位置：[runtime.js:1153](/Users/ranran/Documents/ChatGPT/liuxu/lib/agent/runtime.js:1153)。

触发：父任务委派子任务，子任务调用 `ask_user`，用户回答后子任务和父任务均正常完成。

递归调用 `resumeUserInput(child.id, ...)` 已在末尾通过 `finishDelegateOnParent()` 恢复并完成父任务；外层返回后又执行 `continueDelegatedRun(run, child)`。该函数没有排除终态子任务，会将其重新标成 running 并再次请求模型，随后再次完成父任务。

复现：父子模型原本各需 2 次调用，实际各调用 3 次；父任务产生 2 个 `run.completed` 事件。除重复回复，还会产生额外模型费用；再次返回工具调用时可能继续触发工具操作。

建议：只保留一个负责恢复父任务的调用点，并在驱动与继续运行入口拒绝重新驱动终态 run。

## 7. [P2] 笔记助手的工具限制没有在执行端落实

位置：[runtime.js:704](/Users/ranran/Documents/ChatGPT/liuxu/lib/agent/runtime.js:704)。

`toolsForRun()` 只向笔记助手公布 5 个工具，但处理模型输出时仅规范化名称，没有验证调用是否属于当前 run 的工具集合。`fromProviderName()` 对未知名称原样返回，后续执行仍按全局 AUTO_TOOLS / CONFIRM_TOOLS 分类。模型通过文本 action envelope 返回未公布的点分工具名，仍可执行自动工具或进入不适用于笔记助手的审批流程。

复现：笔记助手公布的工具不含 `task.list`，模拟模型在 envelope 中返回该调用，实际事件显示 `task.list` 执行成功并取得待办。

建议：执行前按当前 run 的有效工具集合校验每一个调用；对未授权工具返回明确错误。现有测试只断言公布给模型的列表，需补充对模型越界输出的负向测试。

## 8. [P2] 文件移入日记后，其批注仍可在锁定状态读取

位置：[documents.js:800](/Users/ranran/Documents/ChatGPT/liuxu/lib/knowledge/documents.js:800)。

批注创建时继承父文件的位置和 visibility，但后续 `updateDocument()` 移动父文件时只写父文件，没有同步关联批注。读取独立批注文档只检查批注自己的 visibility，不重新检查父文件权限。

复现：创建普通文件及批注，将文件 knowledgeBase 改为日记，再以锁定权限读取。父文件不可见，批注仍可通过其文档 ID 读取；其内容和可能引用的图片没有同步获得父文件的新保护。

建议：父文件位置或可见性改变时，在同一事务中同步批注；读取批注时也验证父文件的可访问性。私密图片标记应覆盖同步后的批注内容。

## 9. [P2] 待办接口保存失败仍提示成功并清空输入

位置：[todos.js:637](/Users/ranran/Documents/ChatGPT/liuxu/public/js/todos.js:637)。同类问题也见倒数日保存逻辑。

`apiFetch()` 直接返回原生 fetch，HTTP 400/404/500 不会抛异常。保存函数没有检查 response.ok，收到失败响应后继续显示成功、重置表单并刷新列表。服务器校验失败、存储写入失败或另一标签页已删除目标待办时，用户输入会被丢弃且得到错误反馈。

复现：让 API 返回 HTTP 500；仍调用 `resetTodoForm()` 并提示“任务已添加”。

建议：所有写接口都检查响应状态并读取错误消息，只有成功时清空表单；失败时保留用户输入。倒数日、完成/删除待办及分类操作应同步检查同类分支。

## 修复顺序

优先解决笔记保存与旧 ZIP 恢复的数据丢失，再统一扩展验签；随后修复备份往返与索引失效、Agent 终态和工具限制、批注权限同步及待办错误处理。每项补充针对上述触发路径的回归测试，完成后再运行全量测试。
