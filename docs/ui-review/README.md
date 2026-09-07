# Agent / 知识库 UI 打磨 — 验收记录

日期：2026-09-07。预览端口 `http://127.0.0.1:4218/`（隔离 `DATA_DIR`，静态资源 `Cache-Control: no-store`）。这些改动已随 **v1.2.9** 发布。

## 自动测试 vs 实机视觉

| 层 | 覆盖什么 | 不覆盖什么 |
|---|---|---|
| **自动测试**（`npm test`） | 布局模块、停靠/覆盖规则、消息跟随、日记锁/提案身份、顶栏不再放模式按钮、36px 控件、窄屏 24px 内边距、死 CSS 删除、保存后顶栏副标题不用文档标题 | 像素、对比度、真实流式、审批 dock、混合附件卡片 |
| **实机视觉**（本目录截图 + CDP） | 浅色/深色主路径、停靠与覆盖、空状态、长标题省略、页面横向溢出、窄屏运行状态可见 | 需要已配置模型的流式回复、工具审批、真实附件上传 |

结论：**布局与密度可以按自动测试 + 本轮截图收口。** 流式 / 审批 / 混合附件在代码里已有能力（折叠过程、审批 dock、附件限高+省略），本轮预览未配置模型，未做实机重放。

## 密度收尾（已做）

- 知识侧栏搜索、Agent 会话工具条、相关主按钮：**36px**（设置/待办内部仍 38px）。
- `≤840px`：`--doc-pad-x: 24px`（不再 18px）；文档头 `padding` 实测 `12px 24px`。
- 删除 `.topbar-mode-switch` 死 CSS；模式切换只在左侧 `.workspace-mode-nav`。
- 保存后 `#topbarSubtitle` 写知识库/文件夹路径，不再写成文档标题。知识模式 `#topbarTitle` 固定为「知识库」。
- 窄屏不再 `display:none` 顶栏 `.run-status`。520px 下去掉 `hidden` 后计算样式为可见（`max-width: 42vw`，`overflow: hidden`），页面不横向溢出。
- 长标题：列表与标题输入 `ellipsis`；`scrollWidth > clientWidth` 发生在输入框内部，**页面** `documentElement.scrollWidth === clientWidth`。

## 截图矩阵

路径：`docs/ui-review/screenshots/`。

**改前深色**只有 `before-1440-dark.png`。1280 / 840 / 520 的改前深色无法从当前代码复原，不再伪造。

| 宽度 | 浅色改前 | 浅色改后 | 深色改前 | 深色改后 |
|---|---|---|---|---|
| 1440 | before-1440-light | after-1440-light | before-1440-dark | after-1440-dark |
| 1280 | before-1280-light | after-1280-light | — | after-1280-dark |
| 840 | before-840-light | after-840-light | — | after-840-dark |
| 520 | before-520-light | after-520-light | — | after-520-dark |

补充：

- 停靠：`knowledge-docked-1440-{light,dark}`、`knowledge-docked-1280-{light,dark}`
- 覆盖：`knowledge-overlay-840-dark`、`knowledge-overlay-520-dark`（窄屏自动覆盖，**未写入** `liuxu.noteAssistant.layout`）
- Agent：`agent-1440-dark`、`agent-520-{light,dark}`（520 深色含顶栏「运行中」）
- 空状态：`empty-knowledge-1440-dark`、`empty-search-1440-dark`
- 溢出：`overflow-title-1440-dark`

## 溢出与空状态（CDP）

| 检查 | 结果 |
|---|---|
| 1440 / 1280 / 840 / 520 页面横向溢出 | 无（`scrollWidth === clientWidth`） |
| 840 `--doc-pad-x` / 文档头 | `24px` / `12px 24px` |
| 840 助手 | `data-layout=overlay`，localStorage 偏好仍为空（未覆盖默认停靠） |
| 520 顶栏运行状态 | 去掉 `hidden` 后可见，`max-width ≈ 42vw` |
| Agent 1440 对话列 | `.conversation` 实测宽度 960px |
| 长标题输入 | 内部省略（1214 > 657），页面不撑破 |
| 空搜索 `zzzzznomatch` | 「没有符合条件的知识文档。」 |
| 知识库根 | 「选择一个知识库开始浏览」 |

## 语法与测试

- 相关前端：`public/js/app/workspace-ui.js`、`public/js/knowledge/assistant-layout.js`、`public/js/workbench.js`
- 断言：`test/workspace-layout.test.js`、`test/note-assistant-ui.test.js`、`test/risk-hardening.test.js`
- 整仓：`npm test` — 329 tests, 328 pass, 0 fail, 1 skipped（2026-09-07，约 13s；发布为 v1.2.9）
