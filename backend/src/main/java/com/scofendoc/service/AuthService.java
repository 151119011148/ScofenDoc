package com.scofendoc.service;

import com.scofendoc.dto.AuthConfigDto;
import com.scofendoc.dto.AuthResponse;
import com.scofendoc.dto.UserDto;
import com.scofendoc.entity.User;
import com.scofendoc.entity.Workspace;
import com.scofendoc.repository.UserRepository;
import com.scofendoc.repository.WorkspaceRepository;
import com.scofendoc.security.AuthUser;
import com.scofendoc.security.ForbiddenException;
import com.scofendoc.security.JwtService;
import com.scofendoc.security.UnauthorizedException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 账号体系。
 *
 * 三件事在这里收口：
 *
 * 1) **注册开关**。默认 closed——自托管实例暴露在公网，开放注册等于谁都能进来看。
 *    但留了引导口子：库里一个用户都没有时永远允许注册，第一个人自动成为管理员，
 *    否则关闭注册后新实例会死锁（没人能建第一个号）。
 *
 * 2) **首个用户认领历史数据**。升级前没有登录，空间 owner_id 为空；
 *    第一个注册的人接管这些空间，否则老文档会变成谁都看不见的僵尸数据。
 *
 * 3) **改密与失效**。改密时 tokenVersion+1，JwtAuthFilter 比对不上就拒，
 *    所以"改了密码，别的设备立刻掉线"是真的，而不是等 token 自然过期。
 */
@Service
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    /** 协同光标配色，按用户 id 轮转，保证同一个人颜色稳定 */
    private static final String[] PALETTE = {"#3370ff", "#34c759", "#ff9500", "#af52de", "#00b8d9", "#f54a45"};

    private final UserRepository userRepo;
    private final WorkspaceRepository workspaceRepo;
    private final MembershipService membershipService;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final String registrationMode;

    public AuthService(UserRepository userRepo, WorkspaceRepository workspaceRepo,
                       MembershipService membershipService,
                       PasswordEncoder passwordEncoder, JwtService jwtService,
                       @Value("${scofendoc.auth.registration-mode:closed}") String registrationMode) {
        this.userRepo = userRepo;
        this.workspaceRepo = workspaceRepo;
        this.membershipService = membershipService;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.registrationMode = registrationMode;
    }

    /* ---------------- 实例配置 ---------------- */

    /** 当前是否允许自助注册：显式 open，或还没有任何账号（引导） */
    public AuthConfigDto config() {
        long count = userRepo.count();
        boolean open = "open".equalsIgnoreCase(registrationMode) || count == 0;
        return new AuthConfigDto(open, count > 0, registrationMode);
    }

    /* ---------------- 注册 / 登录 ---------------- */

    @Transactional
    public AuthResponse register(String rawUsername, String rawPassword, String rawDisplayName) {
        long existing = userRepo.count();
        boolean firstUser = existing == 0;
        if (!firstUser && !"open".equalsIgnoreCase(registrationMode)) {
            throw new ForbiddenException("本实例已关闭注册，请联系管理员开通账号");
        }

        String username = normalizeUsername(rawUsername);
        validatePassword(rawPassword);
        if (userRepo.existsByUsername(username)) {
            throw new IllegalArgumentException("用户名已被占用：" + username);
        }

        User u = new User();
        u.setUsername(username);
        u.setPasswordHash(passwordEncoder.encode(rawPassword));
        u.setDisplayName(rawDisplayName == null || rawDisplayName.isBlank()
                ? username : rawDisplayName.trim());
        u.setColor(PALETTE[(int) (existing % PALETTE.length)]);
        // 第一个账号自动成为管理员，否则关闭注册后没人能再建号
        u.setAdmin(firstUser);
        userRepo.save(u);

        boolean adopted = firstUser && adoptOrphanWorkspaces(u);
        if (!adopted) {
            createPersonalWorkspace(u);
        }
        log.info("新用户注册：{}（id={}，管理员={}，接管历史空间={}）",
                u.getUsername(), u.getId(), u.isAdmin(), adopted);

        return buildResponse(u);
    }

    @Transactional(readOnly = true)
    public AuthResponse login(String rawUsername, String rawPassword) {
        String username = rawUsername == null ? "" : rawUsername.trim();
        User u = userRepo.findByUsername(username)
                .orElseThrow(() -> new UnauthorizedException("用户名或密码不正确"));
        if (rawPassword == null || !passwordEncoder.matches(rawPassword, u.getPasswordHash())) {
            throw new UnauthorizedException("用户名或密码不正确");
        }
        return buildResponse(u);
    }

    /** 用 token 里的信息即可，不必每次回查数据库 */
    public UserDto toDto(AuthUser u) {
        return new UserDto(u.id(), u.username(), u.displayName(), u.color(), u.admin());
    }

    public UserDto toDto(User u) {
        return new UserDto(u.getId(), u.getUsername(), u.getDisplayName(), u.getColor(), u.isAdmin());
    }

    /* ---------------- 改密 ---------------- */

    /**
     * 自助改密。改完返回新 token——否则当前这台设备会被自己踢下线，
     * 用户会以为改密失败。
     */
    @Transactional
    public AuthResponse changePassword(Long userId, String oldPassword, String newPassword) {
        User u = userRepo.findById(userId)
                .orElseThrow(() -> new UnauthorizedException("账号不存在"));
        if (oldPassword == null || !passwordEncoder.matches(oldPassword, u.getPasswordHash())) {
            throw new IllegalArgumentException("原密码不正确");
        }
        validatePassword(newPassword);
        if (passwordEncoder.matches(newPassword, u.getPasswordHash())) {
            throw new IllegalArgumentException("新密码不能与原密码相同");
        }
        u.setPasswordHash(passwordEncoder.encode(newPassword));
        u.setTokenVersion(u.getTokenVersion() + 1);
        userRepo.save(u);
        log.info("用户改密：{}（id={}），已使旧 token 全部失效", u.getUsername(), u.getId());
        return buildResponse(u);
    }

    /* ---------------- 管理员 ---------------- */

    public List<UserDto> listUsers() {
        return userRepo.findAll(org.springframework.data.domain.Sort.by("id")).stream()
                .map(this::toDto).toList();
    }

    /** 管理员建号：注册关闭后，团队成员靠这一步进系统 */
    @Transactional
    public UserDto createUser(String rawUsername, String rawPassword, String rawDisplayName, boolean admin) {
        String username = normalizeUsername(rawUsername);
        validatePassword(rawPassword);
        if (userRepo.existsByUsername(username)) {
            throw new IllegalArgumentException("用户名已被占用：" + username);
        }
        User u = new User();
        u.setUsername(username);
        u.setPasswordHash(passwordEncoder.encode(rawPassword));
        u.setDisplayName(rawDisplayName == null || rawDisplayName.isBlank()
                ? username : rawDisplayName.trim());
        u.setColor(PALETTE[(int) (userRepo.count() % PALETTE.length)]);
        u.setAdmin(admin);
        userRepo.save(u);
        createPersonalWorkspace(u);
        log.info("管理员创建账号：{}（id={}）", u.getUsername(), u.getId());
        return toDto(u);
    }

    /** 管理员重置密码：同样让该用户的旧 token 全部失效 */
    @Transactional
    public void resetPassword(Long userId, String newPassword) {
        User u = userRepo.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("用户不存在：" + userId));
        validatePassword(newPassword);
        u.setPasswordHash(passwordEncoder.encode(newPassword));
        u.setTokenVersion(u.getTokenVersion() + 1);
        userRepo.save(u);
        log.info("管理员重置密码：{}（id={}）", u.getUsername(), u.getId());
    }

    /** 授予/取消管理员；不允许取消自己，避免把自己锁在门外 */
    @Transactional
    public UserDto setAdmin(Long userId, boolean admin, Long operatorId) {
        if (userId.equals(operatorId) && !admin) {
            throw new IllegalArgumentException("不能取消自己的管理员权限");
        }
        User u = userRepo.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("用户不存在：" + userId));
        u.setAdmin(admin);
        userRepo.save(u);
        return toDto(u);
    }

    /* ---------------- 内部 ---------------- */

    private AuthResponse buildResponse(User u) {
        AuthUser principal = new AuthUser(
                u.getId(), u.getUsername(), u.getDisplayName(), u.getColor(), u.isAdmin());
        return new AuthResponse(jwtService.issueAuthToken(principal, u.getTokenVersion()), toDto(principal));
    }

    /** 把 owner_id 为空的空间划给该用户，并补上 OWNER 成员行；返回是否认领到了东西 */
    private boolean adoptOrphanWorkspaces(User u) {
        List<Workspace> orphans = workspaceRepo.findByOwnerIdIsNull();
        if (orphans.isEmpty()) {
            return false;
        }
        for (Workspace w : orphans) {
            w.setOwnerId(u.getId());
            w.setOwnerName(u.getDisplayName());
        }
        workspaceRepo.saveAll(orphans);
        // 权限判定只看成员表，认领之后必须把成员行补上，否则所有者自己都进不去
        orphans.forEach(w -> membershipService.grantOwner(w.getId(), u.getId()));
        return true;
    }

    private void createPersonalWorkspace(User u) {
        Workspace w = new Workspace();
        w.setName("我的空间");
        w.setType(Workspace.Type.PERSONAL);
        w.setOwnerId(u.getId());
        w.setOwnerName(u.getDisplayName());
        w.setSortOrder(0);
        workspaceRepo.save(w);
        membershipService.grantOwner(w.getId(), u.getId());
    }

    private void validatePassword(String rawPassword) {
        if (rawPassword == null || rawPassword.length() < 6) {
            throw new IllegalArgumentException("密码至少 6 位");
        }
        if (rawPassword.length() > 72) {
            // BCrypt 只取前 72 字节，超长部分会被静默丢弃，这里直接拒绝更诚实
            throw new IllegalArgumentException("密码不能超过 72 位");
        }
    }

    private String normalizeUsername(String raw) {
        String username = raw == null ? "" : raw.trim();
        if (username.length() < 2 || username.length() > 32) {
            throw new IllegalArgumentException("用户名长度需在 2-32 位之间");
        }
        if (!username.matches("[\\w\\u4e00-\\u9fa5.@-]+")) {
            throw new IllegalArgumentException("用户名只能包含字母、数字、下划线、汉字、点、@ 和短横线");
        }
        return username;
    }
}
