# 笔记内置浏览器架构

笔记内置浏览器只在 Windows 和 macOS 桌面版启用。应用页面负责标签栏、地址栏和布局；远程网页由 Electron 主进程创建的 `WebContentsView` 承载。网页版不会创建内嵌网页视图。

## 进程与隔离

- `electron/note-browser.js` 管理所有标签、导航、边界、页面版本与释放流程。网页使用 `persist:liuxu-note-browser` session，因此内置标签共享登录状态，并与外部 Chrome 分离。
- 远程页面启用 sandbox、context isolation 和 web security，关闭 Node integration，不设置 preload。主进程拒绝该 session 的权限请求，只允许 `http:` 和 `https:` 导航；用户名和密码不会保留在 URL 中。
- 应用渲染页只能通过 `electron/preload.js` 暴露的 `liuxuDesktop.browser` 调用固定 IPC。主进程校验调用来源必须是当前本地应用 origin。网页本身没有这个接口。
- 原生网页视图在应用对话框或浮动助手覆盖其区域时隐藏，避免盖住审批按钮；覆盖层关闭后按原标签和页面状态恢复。

## 状态和布局

`public/js/knowledge/note-browser.js` 维护按文档分组的标签顺序、地址、选中标签、展开状态和宽度，并经 IPC 写入当前数据目录的 `.note-browser-state.json`。文件只保存标签元数据，不包含 Cookie、网页正文或笔记正文。网页 session 的 Cookie 由 Electron 单独持久化。

视图切换只改变可见性和边界。应用重启后按保存地址重建标签，首次显示时加载；不保存网页 DOM 或未提交表单。永久删除当前笔记会关闭并删除其标签，替换恢复会清除整份关联文件。日记锁定会隐藏原生视图，服务端也会拒绝继续读取对应 run。

宽屏由正文、浏览器、助手共同计算可用宽度。正文尽量保留 420px；空间不足时，浏览器与助手使用右侧上下布局；840px 以下使用覆盖布局。浏览器宽度范围为 320–760px，默认 420px，分隔线支持指针拖动和键盘方向键、Home、End。

## 助手工具

`lib/computer/note-browser.js` 把工具调用转换成现有 client-tool 请求，由桌面渲染页转发给主进程。只有绑定文档的 `note_assist` run 及其单层子任务会收到这些工具：

- 自动执行：`note_browser.tabs`、`note_browser.read`、`note_browser.screenshot`。
- 需要确认：`note_browser.open`、`navigate`、`click`、`type`、`select`、`scroll`、`close`。

读取结果包含标题、规范化 URL、正文和最多 300 个编号交互元素；密码字段及脚本、样式、模板会被排除。操作必须携带读取时返回的 `tabId` 和 `pageVersion`。确认后若用户切换笔记或标签、页面发生导航、标签被关闭，主进程会拒绝执行，不会自动改用其他网页。

截图压缩为 JPEG 后经现有 client-tool 路由保存到 `uploads/`，并作为视觉附件提供给支持图片的模型。日记网页截图同步标为私密附件。网页正文和截图在系统提示词及消息中标记为外部、不可信资料，不能改变工具权限或确认规则。

## 验证

- `test/note-browser.test.js`：URL/状态清洗、文档隔离、页面版本、目标切换、沙箱设置和视图释放。
- `test/note-browser-ui.test.js`：每篇笔记的多标签状态、宽度键盘控制、替换恢复清理和日记锁定。
- `test/note-assistant.test.js`：工具可见性、client-tool 回传、审批参数和私密截图。
- `scripts/note-browser-electron-fixture.cjs`：本地模拟网站上的正文读取、截图、表单输入、选择、点击、新标签、跳转、失败加载、渲染进程崩溃和资源释放。通过 `npm run test:note-browser:electron` 单独运行，不进入普通 Node 测试发现范围。
