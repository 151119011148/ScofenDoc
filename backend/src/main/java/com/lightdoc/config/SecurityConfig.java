package com.lightdoc.config;

import com.lightdoc.security.JwtAuthFilter;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * 安全配置：无状态 JWT。
 *
 * 放行的只有健康检查和登录/注册；其余 /api/** 一律要求登录，
 * 空间与文档的归属校验在 Service 层做（同一个空间只属于一个 owner）。
 */
@Configuration
public class SecurityConfig {

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    /**
     * Spring Boot 会把所有 Filter 类型的 Bean 自动注册到 Servlet 容器链上，
     * 导致 JwtAuthFilter 在 Security 链之外再跑一次。这里显式禁用自动注册，
     * 保证它只在 Security 链里执行一次。
     */
    @Bean
    public org.springframework.boot.web.servlet.FilterRegistrationBean<JwtAuthFilter> disableAutoFilterRegistration(
            JwtAuthFilter filter) {
        var registration = new org.springframework.boot.web.servlet.FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http, JwtAuthFilter jwtAuthFilter) throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        // 反代/健康检查探针
                        .requestMatchers("/api/health").permitAll()
                        // 登录注册 + 实例注册策略（登录页要在未登录时就查到能不能注册）
                        .requestMatchers(HttpMethod.POST, "/api/auth/login", "/api/auth/register").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/auth/config").permitAll()
                        // 预检请求
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        .anyRequest().authenticated())
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable)
                // 未登录访问受保护接口：返回 JSON 而不是浏览器的 Basic 认证弹窗
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((req, res, ex) -> writeJson(res, 401, "未登录或登录已过期"))
                        .accessDeniedHandler((req, res, ex) -> writeJson(res, 403, "无权访问该资源")))
                .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }

    private static void writeJson(HttpServletResponse res, int status, String message) throws java.io.IOException {
        res.setStatus(status);
        res.setContentType("application/json;charset=UTF-8");
        res.getWriter().write("{\"error\":\"" + message + "\"}");
    }
}
