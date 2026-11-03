package com.scofendoc.controller;

import com.scofendoc.security.ForbiddenException;
import com.scofendoc.security.UnauthorizedException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;

/**
 * 把业务异常转成带可读信息的 JSON，前端可直接弹提示。
 *
 * 400 参数/业务校验错误；401 未登录或 token 失效；403 越权。
 * 前端 api.ts 会在 401 时清空本地会话并回到登录页，所以这里必须区分 401 和 403，
 * 否则一次越权操作就会把人踢下线。
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> handleIllegalArgument(IllegalArgumentException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(Map.of("error", msg(e, "参数错误")));
    }

    @ExceptionHandler(UnauthorizedException.class)
    public ResponseEntity<Map<String, Object>> handleUnauthorized(UnauthorizedException e) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", msg(e, "未登录或登录已过期")));
    }

    @ExceptionHandler(ForbiddenException.class)
    public ResponseEntity<Map<String, Object>> handleForbidden(ForbiddenException e) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("error", msg(e, "无权访问该资源")));
    }

    private String msg(Exception e, String fallback) {
        return e.getMessage() == null ? fallback : e.getMessage();
    }
}
