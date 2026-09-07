# LiuXu 笔记编辑区全屏化 — Design QA

## Source and capture context

- Reference: `/Users/ranran/Desktop/截屏2026-09-04 22.30.30.png`
- Reference pixels: 3016 × 1662. The screenshot is a macOS desktop capture; density metadata is not embedded, so layout comparisons use its 1.815 aspect ratio and visible app proportions rather than assuming a CSS pixel ratio.
- Implementation preview: `http://127.0.0.1:4173/#knowledge/note%3A1`
- Desktop implementation capture: `/private/tmp/liuxu-editor-preview-1.2.1/final-desktop-edit.jpg`
- Comparison capture: `/private/tmp/liuxu-editor-preview-1.2.1/reference-vs-implementation.jpg`
- Responsive captures: `/private/tmp/liuxu-editor-preview-1.2.1/narrow-840-split.jpg` and `/private/tmp/liuxu-editor-preview-1.2.1/narrow-520-split.jpg`
- Tested states: edit, preview, desktop split, 840px split, 520px split, expanded properties, expanded backlinks/history, wiki-link picker, and 800ms auto-save.

## Iteration history

1. Removed the knowledge view's outer padding and the document card's 1040px width cap, centered margin, border, and radius.
2. Converted the document workspace to a full-size vertical flex surface with a fixed header, flexible editor, and bounded bottom panels.
3. Removed editor-level scrolling so textarea, preview, history, and file preview own their scroll independently.
4. Added responsive toolbar wrapping and verified vertical split behavior at 840px and 520px.

## Evidence

- At 1508 × 831, the main area is 1220 × 831 after the unchanged 288px sidebar. The knowledge workspace is exactly 1220 × 767 at `(288, 64)`, directly under the 64px top bar.
- The document workspace matches the knowledge workspace exactly: 1220 × 767, zero margin, zero border, and zero radius.
- Edit mode uses a 1220 × 592 editor. The textarea owns vertical scrolling (`scrollHeight 1146`, `clientHeight 592`) while the page and editor shell do not scroll.
- Desktop split mode creates two 610px panes (50% / 50%) with a full-height divider.
- At 840px, split mode becomes two 840 × 278 panes separated horizontally; at 520px it becomes two 520 × 254 panes. Both states have zero page overflow.
- Expanding properties increases the header from 128px to 196px and reduces the editor from 592px to 524px without changing the 767px workspace height.
- Expanding backlinks/history reduces the editor to 391px and gives the bottom panel its own 167px bounded scroll area; page overflow remains zero.
- The wiki-link picker remains inside the editor at 520px and reports `aria-expanded="true"` while open.
- Auto-save returned to “已保存”, persisted the test edit, and incremented the document version.
- Browser console warnings/errors: none.

## Five-surface review

- System status: the existing “已保存” state remains visible in every editor mode.
- Empty/loading: the untouched `.knowledge-empty` remains centered because it still owns the available flex space.
- Validation/errors: the link-issue region remains between the independently scrolling editor and bottom relations panel; it participates in flex height calculation instead of overlaying content.
- Core workflow: selecting a note, editing, switching edit/split/preview, opening properties, opening history, and inserting `[[` all remain operational.
- Narrow screens: title and tools wrap without horizontal overflow; split mode stacks vertically and the sidebar remains the existing drawer.

## Final assessment

Passed. The intended deviation from the reference is the requested removal of the centered card treatment: the document now fills the complete main region while retaining the existing visual language and interactions. No blocking visual, responsive, interaction, or console issues remain.

---

# 模型设置 / 生图设置 UI 优化 — Design QA（2026-09-05）

## Scope

- 生图设置从旧版 `details` 手风琴卡片迁移为与模型设置一致的「左列表 + 右详情」双栏工作区（`custom-provider-workspace`）。
- 两页交互修复：连接测试/试生图结果定点更新（不再全量重绘清空输入）、结构化重绘保留焦点与光标（`data-focus-key` + `renderPreservingFocus`）、移除第一张卡强制展开。
- 视觉收束：新增 `--success` / `--success-text` 主题 token（明暗双套），状态点/启用胶囊/测试结果/更新状态全部改走 token；修复未定义的 `var(--border)`（2 处）；删除死 CSS（`.custom-provider-summary*`、旧 `.custom-provider-model-row` 基础块、subhead 隐藏 hack、`.image-model-grid`/`.image-provider-toolbar` 等）；移除 `!important` 样式对抗。
- 移除生图面板遗留隐藏表单（旧版 `#agentImageProvider`/Getoken/Seedream 字段组）及其加载/保存代码；服务端经 `{...current, ...body}` 合并保留存量字段。

## Evidence

- Preview: `http://127.0.0.1:32211/`（临时数据目录，已含旧版 Getoken/Seedream 配置自动迁移为生图供应商）
- 浅色：模型面板（空态 + 双栏）、生图面板（Seedream 详情 4 模型 + 侧栏状态点）
- 深色：生图面板（测试结果 `is-success` 绿色可读、启用胶囊 `--success-text` 对比正确）、模型面板（添加供应商自动聚焦名称）
- 交互验证：连接测试点击后状态块在模型卡内原位出现（`地址格式有效…· 0ms`），未清空任何输入；侧栏滚动位置保持。

## Iteration history

1. conn-grid 两列（`1fr 160px`）为旧布局设计，生图详情下 API 根地址溢出卡片 → 生图详情改为「协议窄列 + 根地址宽列 + Key 独占一行」。
2. 测试状态类 `success/running/error` 与 CSS `.is-*` 脱节（着色从未生效）→ 输出统一为 `is-*`，该样式块由两页共用。
3. `btn ghost` 类在 CSS 中不存在（生图按钮为浏览器默认样式）→ 全部替换为 `secondary-action compact` / `danger-action compact` 体系。

## Known notes

- `express.static` 对 CSS 下发 `Cache-Control: max-age=86400`：升级后浏览器可能命中旧样式一天（既有行为，非本轮引入）。
- `:focus-visible` 在设置导航按钮上会残留高亮（jsdom 点击路径的浏览器焦点行为，视觉无碍）。

---

# Agent / 知识库 UI 打磨 — Design QA（2026-09-07）

## Scope

收口导航侧栏、52px 顶栏、Agent 960 列、知识 chips/更多菜单、助手停靠/浮动/覆盖。本轮补密度小缺口、深色截图矩阵、空状态/溢出检查，以及自动测试 vs 实机视觉的书面结论。不升级版本、不打包。

密度决定：侧栏搜索与 Agent/知识主控件 36px；`≤840` 水平内边距 24px；顶栏运行状态在窄屏保持可见；保存后顶栏副标题用路径而不是文档标题；删除 `.topbar-mode-switch`。

## Evidence

- 隔离预览：`http://127.0.0.1:4218/`（临时 DATA_DIR，静态 `no-store`）
- 截图与矩阵：`docs/ui-review/README.md`、`docs/ui-review/screenshots/`
- 改前深色仅有 1440；其余宽度的改前深色无法从当前 UI 复原
- CDP：1440/1280/840/520 均无页面横向溢出；840 助手为 overlay 且不写偏好；520 运行状态可见；长标题内部省略

## Automated vs visual

- **自动**：停靠规则、跨模式临时浮动、消息跟随、日记锁/提案文档身份、顶栏无模式按钮、36px/24px/死 CSS/副标题路径。这些不代替像素验收。
- **视觉**：浅色改前改后四档宽度已齐；本轮补齐深色改后四档、停靠/覆盖、空知识库、空搜索、长标题、Agent 1440/520。
- **未实机重放**（无模型）：流式不重建输入框、审批 dock、混合附件。代码与既有测试覆盖结构，不记为视觉通过。

## Five-surface review

- 系统状态：知识「已保存」仍在文档头；Agent 窄屏顶栏可显示「运行中」。
- 空/加载：知识库根、无匹配搜索、未选文档均有独立文案；列表滚动与搜索栏分离。
- 校验/错误：归档/删除在 `#documentMore`；提案仍先核对目标文档（测试覆盖）。
- 主路径：左栏模式、知识编辑、停靠助手、切到 Agent 时停靠变临时浮动（测试覆盖）。
- 窄屏：≤840 侧栏抽屉、助手 overlay、编辑/分屏/预览仍在；24px 内边距。

## Final assessment

Passed for layout, density, and the documented visual matrix. Residual risk is live-model interaction (stream / approval / attachments), not the shell. Shipped in v1.2.9.

`npm test`（2026-09-07）：329 tests, 328 pass, 0 fail, 1 skipped.
