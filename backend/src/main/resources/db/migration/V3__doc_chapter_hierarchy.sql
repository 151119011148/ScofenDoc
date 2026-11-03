-- ============================================================================
-- V3 按「第一~六章」分组重建一级文档，并把编号子文档挂回对应章
--
-- 背景：publish-dir.sh --parent 17 批量导入时，1.x~5.x 全部被拍平成「技术栈」
--       的直接子文档；V2 只修了 X.Y.Z 挂回 X.Y，「章」与「节」之间仍缺一层。
--
-- 目标结构（workspace 2，父 = 技术栈 id=17）：
--   技术栈
--   ├── 00-总索引                        （保持不动）
--   ├── 第一章 Java 基础                 → 1.1~1.7（含 1.5 下的 1.5.1）
--   ├── 第二章 框架                      → 2.1~2.4
--   ├── 第三章 数据库                    → 3.1~3.7
--   ├── 第四章 消息队列                  → 4.1~4.3
--   ├── 第五章 架构方法论与实战          → 5.1（含 5.1.1/5.1.2）、5.2
--   └── 第六章 Agent 开发                （空章，待后续导入内容）
--
-- 实现要点：
--   1) 一级章按「标题 + parent_id」判存，幂等；collab_key 用 UUID() 保证唯一
--      （空章无正文，协同房间由前端首次打开时按需创建，无需预置 bin）。
--   2) 子文档按 parent_id=17 + 标题编号前缀（REGEXP '^N[.]'）重挂；
--      已正确的二级挂载（1.5.1→1.5、5.1.1/5.1.2→5.1）parent_id 不是 17，
--      不进入本次 UPDATE，自动保持原状。
--   3) 不动 title / collab_key / 正文；子文档沿用原 sort_order（导入时已按
--      编号连续递增），章内顺序天然正确；一级章取 sort_order 2..7，排在
--      00-总索引(sort=1) 之后。
-- ============================================================================

START TRANSACTION;

-- 1) 新建 6 个一级章（幂等：已存在则跳过）
INSERT INTO doc (workspace_id, parent_id, title, collab_key, sort_order, deleted, created_at, updated_at)
SELECT t.ws, t.pid, t.title, UUID(), t.so, 0, NOW(), NOW()
FROM (
  SELECT 2 AS ws, 17 AS pid, '第一章 Java 基础' AS title, 2 AS so
  UNION ALL SELECT 2, 17, '第二章 框架', 3
  UNION ALL SELECT 2, 17, '第三章 数据库', 4
  UNION ALL SELECT 2, 17, '第四章 消息队列', 5
  UNION ALL SELECT 2, 17, '第五章 架构方法论与实战', 6
  UNION ALL SELECT 2, 17, '第六章 Agent 开发', 7
) t
WHERE NOT EXISTS (
  SELECT 1 FROM doc d
  WHERE d.workspace_id = t.ws
    AND d.parent_id    = t.pid
    AND d.title        = t.title
    AND d.deleted      = 0
);

-- 2) 把各章编号子文档挂到对应一级章下（幂等：重复执行结果一致）
UPDATE doc d
JOIN doc c
  ON  c.workspace_id = 2
  AND c.parent_id    = 17
  AND c.title        = '第一章 Java 基础'
  AND c.deleted      = 0
SET d.parent_id = c.id, d.updated_at = NOW()
WHERE d.workspace_id = 2
  AND d.parent_id    = 17
  AND d.deleted      = 0
  AND d.title REGEXP '^1[.]';

UPDATE doc d
JOIN doc c
  ON  c.workspace_id = 2
  AND c.parent_id    = 17
  AND c.title        = '第二章 框架'
  AND c.deleted      = 0
SET d.parent_id = c.id, d.updated_at = NOW()
WHERE d.workspace_id = 2
  AND d.parent_id    = 17
  AND d.deleted      = 0
  AND d.title REGEXP '^2[.]';

UPDATE doc d
JOIN doc c
  ON  c.workspace_id = 2
  AND c.parent_id    = 17
  AND c.title        = '第三章 数据库'
  AND c.deleted      = 0
SET d.parent_id = c.id, d.updated_at = NOW()
WHERE d.workspace_id = 2
  AND d.parent_id    = 17
  AND d.deleted      = 0
  AND d.title REGEXP '^3[.]';

UPDATE doc d
JOIN doc c
  ON  c.workspace_id = 2
  AND c.parent_id    = 17
  AND c.title        = '第四章 消息队列'
  AND c.deleted      = 0
SET d.parent_id = c.id, d.updated_at = NOW()
WHERE d.workspace_id = 2
  AND d.parent_id    = 17
  AND d.deleted      = 0
  AND d.title REGEXP '^4[.]';

UPDATE doc d
JOIN doc c
  ON  c.workspace_id = 2
  AND c.parent_id    = 17
  AND c.title        = '第五章 架构方法论与实战'
  AND c.deleted      = 0
SET d.parent_id = c.id, d.updated_at = NOW()
WHERE d.workspace_id = 2
  AND d.parent_id    = 17
  AND d.deleted      = 0
  AND d.title REGEXP '^5[.]';

COMMIT;
