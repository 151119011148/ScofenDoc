-- ============================================================================
-- V1 基线：固化现有四张表结构（app_user / workspace / workspace_member / doc）
--
-- 与 JPA 实体严格对齐（ddl-auto=validate 依赖此结构通过校验）。
-- 线上已有库会经 baseline-on-migrate 自动 baseline 到本版本，跳过此建表；
-- 全新空库从本脚本开始建表。
--
-- 列类型对齐线上实际结构：
--   boolean        -> bit(1)
--   LocalDateTime  -> datetime(6)
--   @Enumerated    -> enum(...)
--   @Id IDENTITY   -> bigint AUTO_INCREMENT
-- ============================================================================

-- app_user：用户名保留字规避（user 是 MySQL 8 关键字）
CREATE TABLE IF NOT EXISTS `app_user` (
  `id`             bigint       NOT NULL AUTO_INCREMENT,
  `color`          varchar(16)  NOT NULL,
  `created_at`     datetime(6)  NOT NULL,
  `display_name`   varchar(64)  NOT NULL,
  `password_hash`  varchar(100) NOT NULL,
  `username`       varchar(64)  NOT NULL,
  `is_admin`       bit(1)       NOT NULL,
  `token_version`  int          NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_user_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- workspace：空间（文档容器 + 权限边界）
CREATE TABLE IF NOT EXISTS `workspace` (
  `id`          bigint      NOT NULL AUTO_INCREMENT,
  `created_at`  datetime(6) NOT NULL,
  `name`        varchar(100) NOT NULL,
  `owner_name`  varchar(64)  DEFAULT NULL,
  `sort_order`  int         NOT NULL,
  `type`        enum('PERSONAL','TEAM') NOT NULL,
  `owner_id`    bigint      DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_workspace_owner` (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- workspace_member：权限真相源（角色 OWNER/EDITOR/VIEWER）
CREATE TABLE IF NOT EXISTS `workspace_member` (
  `id`           bigint      NOT NULL AUTO_INCREMENT,
  `created_at`   datetime(6) NOT NULL,
  `role`         enum('EDITOR','OWNER','VIEWER') NOT NULL,
  `user_id`      bigint      NOT NULL,
  `workspace_id` bigint      NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_member_workspace_user` (`workspace_id`,`user_id`),
  KEY `idx_member_user` (`user_id`),
  KEY `idx_member_workspace` (`workspace_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- doc：文档元数据（正文在 Yjs 二进制，见 README）
CREATE TABLE IF NOT EXISTS `doc` (
  `id`           bigint       NOT NULL AUTO_INCREMENT,
  `collab_key`   varchar(64)  NOT NULL,
  `created_at`   datetime(6)  NOT NULL,
  `deleted`      bit(1)       NOT NULL,
  `parent_id`    bigint       DEFAULT NULL,
  `sort_order`   int          NOT NULL,
  `title`        varchar(200) NOT NULL,
  `updated_at`   datetime(6)  NOT NULL,
  `workspace_id` bigint       NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_doc_collab_key` (`collab_key`),
  KEY `idx_doc_workspace` (`workspace_id`),
  KEY `idx_doc_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
