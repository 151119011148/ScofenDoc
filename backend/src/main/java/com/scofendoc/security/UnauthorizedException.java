package com.scofendoc.security;

/** 未登录 / token 失效 → 401 */
public class UnauthorizedException extends RuntimeException {
    public UnauthorizedException(String message) {
        super(message);
    }
}
