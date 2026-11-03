package com.lightdoc.dto;

/** 协同 token：前端用它连 Yjs WebSocket，只能进这一个文档房间 */
public record CollabTokenDto(
        String token,
        long expiresIn
) {
}
