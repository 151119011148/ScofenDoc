package com.scofendoc.dto;

import java.time.LocalDateTime;

/**
 * 搜索结果 / 最近文档的条目。
 *
 * 比 DocDto 多带空间名，因为搜索是跨空间的 —— 结果列表里必须告诉用户
 * "这篇文档在哪个空间"，否则同名文档根本分不清。
 * parentId 只用于跳转后定位层级，前端不依赖它拼整棵树。
 * number 是派生章节号，跨空间搜索时按各自空间单独从 1 开始编号。
 * snippet 是正文命中的上下文片段（只有正文命中时才有；标题命中和「最近更新」为 null），
 * 前端把它显示在标题下方并高亮关键词，用户不用点开文档就知道是不是自己要找的那篇。
 */
public record DocHitDto(
        Long id,
        String title,
        String number,
        Long workspaceId,
        String workspaceName,
        Long parentId,
        LocalDateTime updatedAt,
        String snippet
) {
}
