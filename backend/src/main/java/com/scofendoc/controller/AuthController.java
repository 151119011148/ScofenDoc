package com.scofendoc.controller;

import com.scofendoc.dto.AuthConfigDto;
import com.scofendoc.dto.AuthResponse;
import com.scofendoc.dto.UserDto;
import com.scofendoc.security.AuthUser;
import com.scofendoc.security.CurrentUser;
import com.scofendoc.service.AuthService;
import org.springframework.web.bind.annotation.*;

/**
 * 账号接口。
 *
 * /config 是公开的：登录页要在没登录时就知道"能不能注册"，
 * 否则用户点了注册才被告知"已关闭"，体验和错误提示都很别扭。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    /** 公开：实例注册策略 */
    @GetMapping("/config")
    public AuthConfigDto config() {
        return authService.config();
    }

    @PostMapping("/register")
    public AuthResponse register(@RequestBody Credentials body) {
        return authService.register(body.username(), body.password(), body.displayName());
    }

    @PostMapping("/login")
    public AuthResponse login(@RequestBody Credentials body) {
        return authService.login(body.username(), body.password());
    }

    /** 前端启动时用它校验本地 token 是否还有效 */
    @GetMapping("/me")
    public UserDto me() {
        AuthUser u = CurrentUser.get();
        return authService.toDto(u);
    }

    /** 改密：返回新 token，避免改完把自己踢下线 */
    @PostMapping("/change-password")
    public AuthResponse changePassword(@RequestBody ChangePasswordRequest body) {
        return authService.changePassword(CurrentUser.id(), body.oldPassword(), body.newPassword());
    }

    public record Credentials(String username, String password, String displayName) {
    }

    public record ChangePasswordRequest(String oldPassword, String newPassword) {
    }
}
