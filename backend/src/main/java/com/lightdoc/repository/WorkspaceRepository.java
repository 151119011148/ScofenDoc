package com.lightdoc.repository;

import com.lightdoc.entity.Workspace;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface WorkspaceRepository extends JpaRepository<Workspace, Long> {

    List<Workspace> findAllByOrderBySortOrderAscIdAsc();

    /** 某用户名下的空间（个人空间 + 他建的团队空间） */
    List<Workspace> findByOwnerIdOrderBySortOrderAscIdAsc(Long ownerId);

    /** 带归属校验的查询：不是自己的空间查不出来，不会泄漏存在性 */
    Optional<Workspace> findByIdAndOwnerId(Long id, Long ownerId);

    /** 历史遗留（无 owner）的空间，供首个用户认领 */
    List<Workspace> findByOwnerIdIsNull();

    long countByOwnerId(Long ownerId);
}
