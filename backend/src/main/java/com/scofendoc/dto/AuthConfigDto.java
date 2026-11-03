package com.scofendoc.dto;

/**
 * 登录页启动时查询的实例信息（公开接口，不需要登录）。
 *
 * registrationOpen = 配置允许注册，或本实例还没有任何账号（引导用）。
 * 后端把判断结果直接给前端，前端不用自己拼规则，避免两边逻辑漂移。
 */
public record AuthConfigDto(
        boolean registrationOpen,
        boolean hasUsers,
        String registrationMode
) {
}
