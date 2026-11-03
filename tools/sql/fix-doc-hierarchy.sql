-- ============================================================================
-- light-doc 文档树父子关系修复
-- ----------------------------------------------------------------------------
-- 背景：技术栈等目录用 tools/publish-dir.sh --parent <id> 批量导入时，
--       目录内每个 .md 都被拍平为「导入根」的直接子文档，导致编号
--       X.Y.Z 的文档和 X.Y 的文档平级，而不是 X.Y.Z 挂在 X.Y 之下。
--
-- 规则：doc.title 形如 "1.5.1-Java基础-Netty与网络编程"
--       prefix       = 第一个 '-' 之前的部分，例如 1.5.1
--       parent_prefix= 去掉最后一段点分编号，例如 1.5；顶层(无点)为空
--       * 编号含点(X.Y / X.Y.Z)的文档，其应有父文档 = 前缀等于 parent_prefix 的文档
--       * 顶层编号文档(无点，或 parent_prefix 找不到对应文档)保持挂在导入根下不动
--
--       实测技术栈文件只有 X.Y 与 X.Y.Z 两级（没有单独的 1 / 2 / 3 顶层文件），
--       因此本脚本只会把 X.Y.Z 重新挂到 X.Y 之下，X.Y 章节本身保持根子文档不变。
--
-- 用法：
--   1) 先改下面的 @space_id / @root_parent_id 为你服务器实际值
--      （@root_parent_id = 导入时 --parent 指定的根文档 id）
--   2) 跑【STEP 1 验证(只读)】，逐行核对 intended_parent_id 是否符合预期，
--      重点看 status=MISMATCH 的行：应为 X.Y.Z 挂到 X.Y；X.Y 应保持根子文档(=@root_parent_id)
--   3) 确认无误后跑【STEP 2 执行(写)】，再重跑 STEP 1 应全部 OK
--
-- 连接示例： mysql -u lightdoc -p light_doc < tools/sql/fix-doc-hierarchy.sql
-- （STEP 1/2 用 MySQL 变量与 CTE，需 MySQL 8；可直接整文件执行，STEP 1 只读无副作用）
-- ============================================================================

SET @space_id       = 2;    -- 技术栈所在工作空间 id（按服务器实际填写）
SET @root_parent_id = 17;   -- 导入时 --parent 指定的根文档 id（顶层编号文档的父）

-- ---------------------------------------------------------------------------
-- 公共表达式：为每个编号文档算出 prefix 与 parent_prefix
-- ---------------------------------------------------------------------------
-- 说明：CHAR_LENGTH(prefix)-CHAR_LENGTH(REPLACE(prefix,'.','')) = 点号个数
--       SUBSTRING_INDEX(prefix, '.', 点号个数) = 去掉最后一段，得到 parent_prefix
WITH cte AS (
  SELECT
    id,
    title,
    parent_id                                                            AS cur_parent,
    SUBSTRING_INDEX(title, '-', 1)                                       AS prefix,
    CASE
      WHEN SUBSTRING_INDEX(title, '-', 1) LIKE '%.%'
        THEN SUBSTRING_INDEX(
               SUBSTRING_INDEX(title, '-', 1), '.',
               CHAR_LENGTH(SUBSTRING_INDEX(title, '-', 1))
                 - CHAR_LENGTH(REPLACE(SUBSTRING_INDEX(title, '-', 1), '.', ''))
             )
      ELSE ''
    END                                                                  AS parent_prefix
  FROM doc
  WHERE workspace_id = @space_id
    AND deleted     = 0
    AND title REGEXP '^[0-9]'
)

-- ===========================================================================
-- STEP 1 ── 验证（只读）：列出每篇编号文档的当前父与应有父，标记 MISMATCH
-- ===========================================================================
SELECT
  c.id,
  c.title,
  c.cur_parent,
  CASE
    WHEN c.parent_prefix = '' THEN @root_parent_id   -- 顶层：应挂在导入根
    ELSE p.id                                           -- 嵌套：应挂在 parent_prefix 文档
  END                                                                  AS intended_parent_id,
  CASE
    WHEN c.cur_parent <=> CASE
                           WHEN c.parent_prefix = '' THEN @root_parent_id
                           ELSE p.id
                         END THEN 'OK'
    ELSE 'MISMATCH'
  END                                                                  AS status,
  CASE
    WHEN c.parent_prefix <> '' AND p.id IS NULL THEN '父文档缺失(orphan)'
    ELSE ''
  END                                                                  AS note
FROM cte c
LEFT JOIN doc p
  ON  p.workspace_id = @space_id
  AND p.deleted      = 0
  AND p.title REGEXP '^[0-9]'
  AND SUBSTRING_INDEX(p.title, '-', 1) = c.parent_prefix
ORDER BY c.prefix;

-- ===========================================================================
-- STEP 2 ── 执行（写）：仅把「应有父文档存在」的嵌套文档重新挂到正确父之下；
--           顶层 / 父缺失的文档保持不变（避免出现 NULL 父把章节误提为根）
-- ===========================================================================
UPDATE doc d
JOIN cte c ON c.id = d.id
LEFT JOIN doc p
  ON  p.workspace_id = @space_id
  AND p.deleted      = 0
  AND p.title REGEXP '^[0-9]'
  AND SUBSTRING_INDEX(p.title, '-', 1) = c.parent_prefix
SET d.parent_id =
      CASE
        WHEN c.parent_prefix = '' THEN @root_parent_id
        ELSE p.id
      END
WHERE d.workspace_id = @space_id
  AND d.deleted      = 0
  AND d.title REGEXP '^[0-9]'
  AND (c.parent_prefix = '' OR p.id IS NOT NULL);   -- 父缺失(orphan)不动，交给人工核对
