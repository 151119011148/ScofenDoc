package com.lightdoc.controller;

import com.lightdoc.dto.MemberDto;
import com.lightdoc.entity.WorkspaceMember;
import com.lightdoc.security.CurrentUser;
import com.lightdoc.service.MembershipService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 空间成员管理。
 *
 * 只有空间所有者能增删改成员（Service 层用 requireManage 兜住），
 * 普通成员只能看名单——知道"这个空间还有谁"是协作的基本需要，
 * 但不该能看到别人的账号细节，所以 MemberDto 里不含任何密码/邮箱类字段。
 */
@RestController
@RequestMapping("/api/workspaces/{workspaceId}/members")
public class WorkspaceMemberController {

    private final MembershipService membership;

    public WorkspaceMemberController(MembershipService membership) {
        this.membership = membership;
    }

    @GetMapping
    public List<MemberDto> list(@PathVariable Long workspaceId) {
        return membership.list(workspaceId, CurrentUser.id());
    }

    /** 按用户名邀请（注册已关闭，账号由管理员创建，用户名是双方都确定的标识） */
    @PostMapping
    public MemberDto invite(@PathVariable Long workspaceId, @RequestBody InviteRequest body) {
        return membership.invite(workspaceId, body.username(), parseRole(body.role()), CurrentUser.id());
    }

    @PatchMapping("/{userId}")
    public MemberDto changeRole(@PathVariable Long workspaceId, @PathVariable Long userId,
                                @RequestBody Map<String, Object> body) {
        String role = body.get("role") == null ? null : String.valueOf(body.get("role"));
        return membership.changeRole(workspaceId, userId, parseRole(role), CurrentUser.id());
    }

    @DeleteMapping("/{userId}")
    public Map<String, Object> remove(@PathVariable Long workspaceId, @PathVariable Long userId) {
        membership.remove(workspaceId, userId, CurrentUser.id());
        return Map.of("removed", true);
    }

    /** 角色白名单解析：非法值直接拒，避免写进库后前端渲染出未知角色 */
    private WorkspaceMember.Role parseRole(String raw) {
        if (raw == null || raw.isBlank()) {
            return WorkspaceMember.Role.EDITOR;
        }
        try {
            return WorkspaceMember.Role.valueOf(raw.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("角色只能是 EDITOR 或 VIEWER");
        }
    }

    public record InviteRequest(String username, String role) {
    }
}
