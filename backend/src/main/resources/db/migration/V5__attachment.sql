-- 正文附件：任意文件的元数据。
--
-- 为什么单独建表而不是像图片那样只把 URL 写进正文：
--   1. 附件下载必须保留「原始文件名」（UUID 存储名对用户没意义），这只能由服务端记录；
--   2. 附件可能含敏感内容（合同/标书），下载要按文档所属空间做权限校验，不能像静态图片那样 URL 泄露即可取；
--   3. 落盘用独立目录（不在 Nginx 静态映射下），只能通过带鉴权的 /api/attachments/{id}/download 取回。
--
-- 文件本体落在 scofendoc.attachments.dir/yyyyMM/<uuid>.<ext>；正文里只存 {id,name,size}，不存字节。
CREATE TABLE IF NOT EXISTS `attachment` (
  `id`            bigint       NOT NULL AUTO_INCREMENT,
  `doc_id`        bigint       NOT NULL,
  `stored_name`   varchar(128) NOT NULL COMMENT '落盘文件名（UUID，无扩展名语义）',
  `original_name` varchar(500) NOT NULL COMMENT '用户看到的原始文件名',
  `content_type`  varchar(200) DEFAULT NULL,
  `size_bytes`    bigint       NOT NULL,
  `uploaded_by`   bigint       DEFAULT NULL,
  `created_at`    datetime(6)  NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_attachment_doc` (`doc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
