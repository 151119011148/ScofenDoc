package com.scofendoc.dto;

/** 当前登录用户对外视图（不含任何密码信息） */
public record UserDto(
        Long id,
        String username,
        String displayName,
        String color,
        /** 是否管理员：可创建账号、重置他人密码 */
        boolean admin
) {
}
