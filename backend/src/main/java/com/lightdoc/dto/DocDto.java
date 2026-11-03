package com.lightdoc.dto;

import java.time.LocalDateTime;

/**
 * 文档对外视图（扁平结构 + parentId）。
 * 前端拿到扁平列表后自己组装成树，好处是一次请求即可渲染整棵树，
 * 也便于前端做"展开/收起"的本地状态。
 */
public record DocDto(
        Long id,
        Long workspaceId,
        Long parentId,
        String title,
        String collabKey,
        int sortOrder,
        LocalDateTime updatedAt
) {
}
