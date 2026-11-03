-- ============================================================================
-- V4 空间分类：文档库（DOC） / 知识库（KB）
--
-- 背景：产品要区分「文档库」（日常文档，现有全部内容）和「知识库」（沉淀性内容）。
--       两者共用同一套空间/文档/权限模型，只是入口与导航归组不同，
--       所以在 workspace 上加一个分类字段最省事，不必新建表。
--
-- 存量处理：DEFAULT 'DOC'，现有空间全部落入文档库 —— 与「目前的文档都在文档库中」一致。
--
-- 类型用 enum：Hibernate @Enumerated(STRING) 在 MySQL 上映射为 enum，
-- ddl-auto=validate 会比对列类型，写成 varchar 会启动失败。
-- ============================================================================

ALTER TABLE `workspace`
  ADD COLUMN `kind` ENUM('DOC','KB') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'DOC'
  AFTER `type`;
