package com.scofendoc.dto;

import java.time.LocalDateTime;

/**
 * 文档对外视图（扁平结构 + parentId）。
 * 前端拿到扁平列表后自己组装成树，好处是一次请求即可渲染整棵树，
 * 也便于前端做"展开/收起"的本地状态。
 *
 * number 是树形章节号（1 / 1.1 / 1.1.1），由服务端按层级派生、不落库，
 * 所以拖动改层级或顺序之后重新拉一次列表，编号就自动跟着变。
 */
public record DocDto(
        Long id,
        Long workspaceId,
        Long parentId,
        String title,
        String number,
        String collabKey,
        int sortOrder,
        LocalDateTime updatedAt
) {
}
