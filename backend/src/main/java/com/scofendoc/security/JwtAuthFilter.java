package com.scofendoc.security;

import com.scofendoc.entity.User;
import com.scofendoc.repository.UserRepository;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 解析 Authorization: Bearer <token>，把用户放进 SecurityContext。
 *
 * 对无效 token 不直接报错，而是保持匿名，交给后面的授权规则处理：
 * 需要登录的接口会由 SecurityConfig 的 entryPoint 统一返回 401 JSON。
 *
 * 只有 typ=auth 的 token 才能当登录态用——协同 token 即使泄漏也无法调 /api/**。
 *
 * 这里多做了一件事：**比对 token 里的 pv 与库里的 tokenVersion**。
 * 代价是每个请求一次主键查询（小实例完全可接受），换来的是：
 *   - 改密码 / 被重置密码后，其它设备上的旧 token 立刻失效，不用等 7 天；
 *   - 用户被删除后立刻掉线；
 *   - admin 标识取库里的实时值，降权即时生效。
 */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    private final JwtService jwtService;
    private final UserRepository userRepo;

    public JwtAuthFilter(JwtService jwtService, UserRepository userRepo) {
        this.jwtService = jwtService;
        this.userRepo = userRepo;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {

        String raw = request.getHeader("Authorization");
        if (raw != null && raw.startsWith("Bearer ")) {
            String token = raw.substring(7).trim();
            try {
                Claims claims = jwtService.parse(token);
                if (JwtService.TYP_AUTH.equals(claims.get("typ", String.class))) {
                    Long userId = Long.valueOf(claims.getSubject());
                    User u = userRepo.findById(userId).orElse(null);
                    Integer pv = claims.get("pv", Integer.class);
                    // 用户已删除，或 token 是改密前签发的 → 一律按未登录处理
                    if (u != null && pv != null && pv == u.getTokenVersion()) {
                        AuthUser principal = new AuthUser(
                                u.getId(), u.getUsername(), u.getDisplayName(), u.getColor(), u.isAdmin());
                        var auth = new UsernamePasswordAuthenticationToken(principal, null, List.of());
                        SecurityContextHolder.getContext().setAuthentication(auth);
                    } else {
                        SecurityContextHolder.clearContext();
                    }
                }
            } catch (JwtException | IllegalArgumentException ignored) {
                // 无效/过期 token：保持匿名，让授权规则决定是否 401
                SecurityContextHolder.clearContext();
            }
        }
        chain.doFilter(request, response);
    }
}
