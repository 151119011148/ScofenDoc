-- ============================================================================
-- V2 文档树父子关系修复
--
-- 背景：技术栈等目录用 publish-dir.sh --parent <id> 批量导入时，目录内每个 .md
--       都被拍平为「导入根」的直接子文档，导致编号 X.Y.Z 与 X.Y 平级。
--
-- 规则：doc.title 形如 "1.5.1-Java基础-Netty与网络编程"
--       prefix        = 第一个 '-' 之前的部分，例如 1.5.1
--       parent_prefix = 去掉最后一段点分编号，例如 1.5；顶层(无点)为空
--       编号含点的文档，其应有父文档 = 同 workspace 内前缀等于 parent_prefix 的文档；
--       顶层编号文档（无点）保持挂导入根不动；父缺失的孤儿不动，留人工核对。
--
-- 通用、幂等、不硬编码 id：既修当前数据，也对未来新导入的编号文档生效。
-- ============================================================================

UPDATE doc d
JOIN (
  SELECT
    id,
    workspace_id,
    SUBSTRING_INDEX(title, '-', 1) AS prefix,
    CASE
      WHEN SUBSTRING_INDEX(title, '-', 1) LIKE '%.%'
        THEN SUBSTRING_INDEX(
               SUBSTRING_INDEX(title, '-', 1), '.',
               CHAR_LENGTH(SUBSTRING_INDEX(title, '-', 1))
                 - CHAR_LENGTH(REPLACE(SUBSTRING_INDEX(title, '-', 1), '.', ''))
             )
      ELSE ''
    END AS parent_prefix
  FROM doc
  WHERE deleted = 0
    AND title REGEXP '^[0-9]'
) c ON c.id = d.id
LEFT JOIN doc p
  ON  p.workspace_id = c.workspace_id
  AND p.deleted      = 0
  AND p.title REGEXP '^[0-9]'
  AND SUBSTRING_INDEX(p.title, '-', 1) = c.parent_prefix
SET d.parent_id = p.id
WHERE d.deleted = 0
  AND d.title REGEXP '^[0-9]'
  AND c.parent_prefix <> ''
  AND p.id IS NOT NULL;
