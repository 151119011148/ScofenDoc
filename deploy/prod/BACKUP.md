# ScofenDoc 备份与恢复

## 生成归档

在 Linux 生产主机上运行 `bash /opt/scofendoc/deploy/backup.sh create`。配置仅备份账号可读的 MySQL 客户端配置文件，用 `SCOFENDOC_MYSQL_CONFIG` 指定路径。默认使用 `/root/.my.cnf`。如果部署修改过目录或数据库名，设置 `COLLAB_DATA_DIR`、`SCOFENDOC_FILES_DIR`、`SCOFENDOC_ATTACHMENTS_DIR`、`SCOFENDOC_DB_NAME`，使其与服务配置一致。

脚本暂时停止后端与协同服务，导出 MySQL 并复制正文、历史版本、图片及附件。完成复制后启动服务，随后压缩和校验。归档及配套的 `.sha256` 默认写入 `/opt/scofendoc/backup`，可以用 `SCOFENDOC_BACKUP_DIR` 修改。两个文件应一起保存到受限的独立存储。归档包含账号密码哈希、文档内容和附件。

## 在隔离环境恢复

1. 运行 `bash backup.sh verify /path/to/scofendoc-<时间>.tar.gz` 校验归档。
2. 运行 `bash backup.sh stage /path/to/scofendoc-<时间>.tar.gz /path/to/new-restore-dir`，解包到新目录。
3. 使用与原实例版本一致的 Node 依赖运行 `node /opt/scofendoc/collab/backup.js /path/to/new-restore-dir/collab`，检查各房间和快照的 Yjs 数据。
4. 在隔离 MySQL 实例创建空数据库，用仅对该库有权限的账号执行 `mysql --defaults-extra-file=/path/to/isolated-client.cnf scofen_doc_restore < /path/to/new-restore-dir/database.sql`。
5. 在隔离端口启动同版本的后端、协同服务和前端。后端使用恢复库和解包后的图片、附件目录。协同服务的 `COLLAB_DATA_DIR` 指向解包后的 `collab`，`COLLAB_ACCESS_URL` 指向隔离后端，后端的 `COLLAB_SEARCH_URL` 指向隔离协同服务。给两个服务配置相同的新 `JWT_SECRET`，并配置图片 URL 对应的静态目录。
6. 打开一篇已知文档，确认正文、批注、图片和附件可读。核对空间成员权限、一次版本预览、一次回收站恢复和一条未过期的分享链接。检查正文索引能检索所选文档；记录演练使用的归档、时间和结果。

正式恢复时，停止应用并先保留现状归档。使用演练通过的同一套数据库、正文及文件恢复步骤，把服务指向成套恢复的数据库和目录后启动。

归档覆盖应用数据。systemd、Nginx 配置和运行密钥按部署环境单独保管。
