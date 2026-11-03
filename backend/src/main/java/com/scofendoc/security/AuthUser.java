package com.scofendoc.security;

/**
 * 已登录用户身份（作为 Spring Security 的 principal 放进 SecurityContext）。
 * 全为不可变字段，可安全跨线程读取。
 *
 * admin 由 JwtAuthFilter 每次从数据库取最新值填入，而不是从 token 里读，
 * 这样把某人降为普通用户后立刻生效，不用等他重新登录。
 */
public record AuthUser(
        Long id,
        String username,
        String displayName,
        String color,
        boolean admin
) {
}
