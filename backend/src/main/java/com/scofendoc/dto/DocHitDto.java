package com.scofendoc.dto;

import java.time.LocalDateTime;

/**
 * 搜索结果 / 最近文档的条目。
 *
 * 比 DocDto 多带空间名，因为搜索是跨空间的 —— 结果列表里必须告诉用户
 * "这篇文档在哪个空间"，否则同名文档根本分不清。
 * parentId 只用于跳转后定位层级，前端不依赖它拼整棵树。
 */
public record DocHitDto(
        Long id,
        String title,
        Long workspaceId,
        String workspaceName,
        Long parentId,
        LocalDateTime updatedAt
) {
}
