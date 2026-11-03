package com.scofendoc.dto;

/** 空间成员对外视图 */
public record MemberDto(
        Long userId,
        String username,
        String displayName,
        String color,
        /** OWNER / EDITOR / VIEWER */
        String role,
        String joinedAt
) {
}
