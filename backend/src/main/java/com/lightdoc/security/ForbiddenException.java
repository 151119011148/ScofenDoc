package com.lightdoc.security;

/** 已登录但无权访问该资源 → 403 */
public class ForbiddenException extends RuntimeException {
    public ForbiddenException(String message) {
        super(message);
    }
}
