package com.lightdoc.security;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/** 从 SecurityContext 取当前登录用户。取不到即视为未登录，直接 401 语义。 */
public final class CurrentUser {

    private CurrentUser() {
    }

    public static AuthUser get() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof AuthUser u) {
            return u;
        }
        throw new UnauthorizedException("未登录或登录已过期");
    }

    public static Long id() {
        return get().id();
    }
}
