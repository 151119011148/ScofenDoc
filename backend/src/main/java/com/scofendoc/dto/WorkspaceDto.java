package com.scofendoc.dto;

/**
 * 空间对外视图。
 *
 * role 是**当前登录用户**在这个空间里的角色，前端据此决定能否写、能否管成员；
 * memberCount 用于在空间列表上提示"这是共享空间，共 N 人"。
 * kind 区分文档库（DOC）与知识库（KB），前端据此把空间归入不同导航入口。
 */
public record WorkspaceDto(
        Long id,
        String name,
        String type,
        String kind,
        String ownerName,
        String role,
        long memberCount
) {
}
