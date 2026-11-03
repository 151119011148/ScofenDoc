package com.scofendoc.dto;

/** 登录/注册返回：token + 用户信息 */
public record AuthResponse(
        String token,
        UserDto user
) {
}
