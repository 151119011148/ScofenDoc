package com.lightdoc.controller;

import com.lightdoc.dto.UserDto;
import com.lightdoc.security.AuthUser;
import com.lightdoc.security.CurrentUser;
import com.lightdoc.security.ForbiddenException;
import com.lightdoc.service.AuthService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 管理员接口：账号增发与密码重置。
 *
 * 存在的理由很直接——注册关了之后，团队成员必须有人给他们开号，
 * 否则"收紧注册"就变成了"这个实例只能一个人用"。
 *
 * 管理员自己不能取消自己的管理员权限（见 AuthService#setAdmin），
 * 避免唯一的管理员手滑把自己降权，之后再没人能进管理面板。
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final AuthService authService;

    public AdminController(AuthService authService) {
        this.authService = authService;
    }

    @GetMapping("/users")
    public List<UserDto> users() {
        requireAdmin();
        return authService.listUsers();
    }

    @PostMapping("/users")
    public UserDto create(@RequestBody CreateUserRequest body) {
        requireAdmin();
        return authService.createUser(body.username(), body.password(), body.displayName(),
                Boolean.TRUE.equals(body.admin()));
    }

    @PostMapping("/users/{id}/reset-password")
    public Map<String, Object> resetPassword(@PathVariable Long id, @RequestBody Map<String, Object> body) {
        requireAdmin();
        Object pwd = body.get("password");
        authService.resetPassword(id, pwd == null ? null : String.valueOf(pwd));
        return Map.of("reset", true);
    }

    @PatchMapping("/users/{id}")
    public UserDto update(@PathVariable Long id, @RequestBody Map<String, Object> body) {
        AuthUser me = requireAdmin();
        boolean admin = Boolean.TRUE.equals(body.get("admin"));
        return authService.setAdmin(id, admin, me.id());
    }

    private AuthUser requireAdmin() {
        AuthUser u = CurrentUser.get();
        if (!u.admin()) {
            throw new ForbiddenException("需要管理员权限");
        }
        return u;
    }

    public record CreateUserRequest(String username, String password, String displayName, Boolean admin) {
    }
}
