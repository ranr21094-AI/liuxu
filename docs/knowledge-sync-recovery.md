# 知识库同步恢复（v1.4.8）

文件夹同步跳过以 `.app` 结尾的目录（忽略大小写），包括嵌套程序包。它们内部的变更不会触发同步；过去已导入的记录也不会因为程序包移走而自动删除。默认同步文档、图片、音视频及代码后缀，可在设置 → 知识库中修改后缀列表；Markdown 笔记始终同步。其余文件及程序包以“未同步”项显示，只展示名称和相对路径，不解析、复制、预览或写入数据库。已导入但后来被排除的附件保留上次快照，停止更新及缺失删除判定。

同步处理每 25 个文件让出一次执行时间。SQLite schema 6 增加 `parentDocumentId` 表达式索引，使文件写入仅查询相关子文档。

名称项通过本机只读 `GET /api/knowledge/local-entries?knowledgeBase=…&folder=…` 获取，遵循日记锁定规则；远程客户端不返回本机未同步名称。同步配置接口增加 `syncExtensions` 列表（小写、去重），只允许格式注册表中的后缀，并始终保留 `.md`。

## 本机 Blender 误导入清理

`scripts/cleanup-blender-sync.cjs` 不随应用启动执行。先关闭文件夹同步并退出应用。默认仅预览：

```sh
node scripts/cleanup-blender-sync.cjs --data-dir '/absolute/path/to/data'
```

执行时指定尚不存在的备份目录，建议位于应用数据目录内、知识库根目录外：

```sh
node scripts/cleanup-blender-sync.cjs --data-dir '/absolute/path/to/data' --backup-dir '/absolute/path/to/data/sync-recovery-backup' --apply
```

脚本只清理同步路径在 `Agent/设计/haibara-card/tools/Blender.app/` 下的导入文件记录。带子文档（包括用户批注）的父记录、原始程序包、笔记和附件副本全部保留。备份包含一致的 SQLite 数据库、原同步配置、清单、清理列表及结果。数据库删除及搜索变更写入同一事务；清单写入失败会回滚，保留备份供恢复。

恢复备份时保持应用退出：用备份 `schedule.db` 恢复数据目录数据库，并移除退出后残留的同名 `-wal`/`-shm` 文件；将 `knowledge-folder.json` 恢复为 `.knowledge-folder.json`，将 `manifest.json` 恢复至知识库 `.liuxu/manifest.json`。数据备份中的同步状态为暂停。恢复旧版应用时继续保持同步暂停，否则可能重新导入程序包。
