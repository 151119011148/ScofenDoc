package com.lightdoc.repository;

import com.lightdoc.entity.WorkspaceMember;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface WorkspaceMemberRepository extends JpaRepository<WorkspaceMember, Long> {

    /** 我在哪些空间里有权限（跨个人空间与被邀请的团队空间） */
    List<WorkspaceMember> findByUserId(Long userId);

    List<WorkspaceMember> findByWorkspaceIdOrderByRoleAscIdAsc(Long workspaceId);

    Optional<WorkspaceMember> findByWorkspaceIdAndUserId(Long workspaceId, Long userId);

    boolean existsByWorkspaceIdAndUserId(Long workspaceId, Long userId);

    long countByWorkspaceId(Long workspaceId);

    /** 我加入了多少个空间，用于新建空间的排序号 */
    long countByUserId(Long userId);

    /** 删除某人时清掉他的全部成员关系 */
    void deleteByUserId(Long userId);

    void deleteByWorkspaceIdAndUserId(Long workspaceId, Long userId);
}
