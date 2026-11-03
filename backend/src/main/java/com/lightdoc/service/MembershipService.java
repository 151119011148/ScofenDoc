package com.lightdoc.service;

import com.lightdoc.dto.MemberDto;
import com.lightdoc.entity.User;
import com.lightdoc.entity.Workspace;
import com.lightdoc.entity.WorkspaceMember;
import com.lightdoc.repository.UserRepository;
import com.lightdoc.repository.WorkspaceMemberRepository;
import com.lightdoc.repository.WorkspaceRepository;
import com.lightdoc.security.AuthUser;
import com.lightdoc.security.ForbiddenException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 权限判定的唯一入口。
 *
 * 之前权限是「workspace.owner_id == 当前用户」，那套模型天生不支持共享。
 * 现在统一改成查 workspace_member：
 *   不是成员 → 403（对返回结果而言，"不存在"和"没权限"不可区分，避免被探测）
 *   成员但角色不够 → 403
 *
 * 所有 Service 都不再自己比对 ownerId，避免出现"某个接口忘了校验"的漏网之鱼。
 */
@Service
public class MembershipService {

    private final WorkspaceRepository workspaceRepo;
    private final WorkspaceMemberRepository memberRepo;
    private final UserRepository userRepo;

    public MembershipService(WorkspaceRepository workspaceRepo,
                             WorkspaceMemberRepository memberRepo,
                             UserRepository userRepo) {
        this.workspaceRepo = workspaceRepo;
        this.memberRepo = memberRepo;
        this.userRepo = userRepo;
    }

    /** 空间 + 我在其中的角色 */
    public record Access(Workspace workspace, WorkspaceMember.Role role) {
    }

    /** 查我的角色；不是成员返回 null */
    public WorkspaceMember.Role roleOf(Long workspaceId, Long userId) {
        return memberRepo.findByWorkspaceIdAndUserId(workspaceId, userId)
                .map(WorkspaceMember::getRole)
                .orElse(null);
    }

    /** 只读权限（能看） */
    public Access requireView(Long workspaceId, Long userId) {
        Workspace w = workspaceRepo.findById(workspaceId)
                .orElseThrow(() -> new ForbiddenException("空间不存在或无权访问：" + workspaceId));
        WorkspaceMember.Role role = roleOf(workspaceId, userId);
        if (role == null) {
            throw new ForbiddenException("空间不存在或无权访问：" + workspaceId);
        }
        return new Access(w, role);
    }

    /** 写权限（建/改/删文档） */
    public Access requireWrite(Long workspaceId, Long userId) {
        Access a = requireView(workspaceId, userId);
        if (!a.role().canWrite()) {
            throw new ForbiddenException("你在此空间是「仅查看」权限，不能修改内容");
        }
        return a;
    }

    /** 管理权限（管成员） */
    public Access requireManage(Long workspaceId, Long userId) {
        Access a = requireView(workspaceId, userId);
        if (!a.role().canManage()) {
            throw new ForbiddenException("只有空间所有者可以管理成员");
        }
        return a;
    }

    /* ---------------- 成员维护 ---------------- */

    /** 建空间/认领空间时写入所有者成员行；已存在则修正为 OWNER */
    @Transactional
    public void grantOwner(Long workspaceId, Long userId) {
        WorkspaceMember m = memberRepo.findByWorkspaceIdAndUserId(workspaceId, userId)
                .orElseGet(() -> {
                    WorkspaceMember x = new WorkspaceMember();
                    x.setWorkspaceId(workspaceId);
                    x.setUserId(userId);
                    return x;
                });
        m.setRole(WorkspaceMember.Role.OWNER);
        memberRepo.save(m);
    }

    /**
     * 按用户名邀请成员。
     *
     * 之所以是"按用户名邀请"而不是发邮件/邀请链接：
     * 本实例注册是关闭的，账号由管理员创建，用户名是双方都知道的稳定标识，
     * 不需要再引入邮件通道和邀请码过期逻辑。
     */
    @Transactional
    public MemberDto invite(Long workspaceId, String rawUsername, WorkspaceMember.Role role, Long operatorId) {
        Workspace w = requireManage(workspaceId, operatorId).workspace();
        if (w.getType() != Workspace.Type.TEAM) {
            throw new IllegalArgumentException("个人空间不支持成员共享，请先新建团队空间");
        }
        String username = rawUsername == null ? "" : rawUsername.trim();
        if (username.isEmpty()) {
            throw new IllegalArgumentException("请输入要邀请的用户名");
        }
        User target = userRepo.findByUsername(username)
                .orElseThrow(() -> new IllegalArgumentException("用户不存在：" + username));
        if (memberRepo.existsByWorkspaceIdAndUserId(workspaceId, target.getId())) {
            throw new IllegalArgumentException("该用户已是空间成员：" + username);
        }
        WorkspaceMember m = new WorkspaceMember();
        m.setWorkspaceId(workspaceId);
        m.setUserId(target.getId());
        m.setRole(role == null || role == WorkspaceMember.Role.OWNER
                ? WorkspaceMember.Role.EDITOR : role);
        memberRepo.save(m);
        return toDto(m, target);
    }

    /** 改角色；所有者的角色不可变更（避免把空间改成没人管） */
    @Transactional
    public MemberDto changeRole(Long workspaceId, Long userId, WorkspaceMember.Role role, Long operatorId) {
        requireManage(workspaceId, operatorId);
        WorkspaceMember m = memberRepo.findByWorkspaceIdAndUserId(workspaceId, userId)
                .orElseThrow(() -> new IllegalArgumentException("该用户不是空间成员"));
        if (m.getRole() == WorkspaceMember.Role.OWNER) {
            throw new IllegalArgumentException("不能修改空间所有者的角色");
        }
        if (role == null || role == WorkspaceMember.Role.OWNER) {
            throw new IllegalArgumentException("角色只能是 EDITOR 或 VIEWER");
        }
        m.setRole(role);
        memberRepo.save(m);
        User u = userRepo.findById(userId).orElse(null);
        return toDto(m, u);
    }

    /** 移除成员：所有者不能被移除 */
    @Transactional
    public void remove(Long workspaceId, Long userId, Long operatorId) {
        requireManage(workspaceId, operatorId);
        WorkspaceMember m = memberRepo.findByWorkspaceIdAndUserId(workspaceId, userId)
                .orElseThrow(() -> new IllegalArgumentException("该用户不是空间成员"));
        if (m.getRole() == WorkspaceMember.Role.OWNER) {
            throw new IllegalArgumentException("不能移除空间所有者");
        }
        memberRepo.delete(m);
    }

    /** 成员列表（含所有者）；用于成员管理面板 */
    public List<MemberDto> list(Long workspaceId, Long operatorId) {
        requireView(workspaceId, operatorId);
        List<WorkspaceMember> rows = memberRepo.findByWorkspaceIdOrderByRoleAscIdAsc(workspaceId);
        if (rows.isEmpty()) {
            return List.of();
        }
        Map<Long, User> users = new java.util.HashMap<>();
        userRepo.findAllById(rows.stream().map(WorkspaceMember::getUserId).toList())
                .forEach(u -> users.put(u.getId(), u));
        List<MemberDto> out = new ArrayList<>();
        for (WorkspaceMember m : rows) {
            User u = users.get(m.getUserId());
            if (u != null) {
                out.add(toDto(m, u));
            }
        }
        return out;
    }

    /** 我在该空间的角色；不是成员返回 null（不抛异常，供列表过滤用） */
    public Optional<WorkspaceMember.Role> findRole(Long workspaceId, Long userId) {
        return memberRepo.findByWorkspaceIdAndUserId(workspaceId, userId).map(WorkspaceMember::getRole);
    }

    public long memberCount(Long workspaceId) {
        return memberRepo.countByWorkspaceId(workspaceId);
    }

    private MemberDto toDto(WorkspaceMember m, User u) {
        return new MemberDto(
                m.getUserId(),
                u == null ? "已注销用户" : u.getUsername(),
                u == null ? "已注销用户" : u.getDisplayName(),
                u == null ? "#999999" : u.getColor(),
                m.getRole().name(),
                m.getCreatedAt() == null ? null : m.getCreatedAt().toString());
    }
}
