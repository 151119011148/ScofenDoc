package com.scofendoc.service;

import com.scofendoc.dto.CollabTokenDto;
import com.scofendoc.dto.DocDto;
import com.scofendoc.dto.DocHitDto;
import com.scofendoc.dto.WorkspaceDto;
import com.scofendoc.entity.Doc;
import com.scofendoc.entity.Workspace;
import com.scofendoc.entity.WorkspaceMember;
import com.scofendoc.repository.DocRepository;
import com.scofendoc.repository.WorkspaceMemberRepository;
import com.scofendoc.repository.WorkspaceRepository;
import com.scofendoc.security.AuthUser;
import com.scofendoc.security.ForbiddenException;
import com.scofendoc.security.JwtService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * 空间与文档元数据服务。
 *
 * 权限模型（相比上一版的关键变化）：
 *   上一版是 workspace.owner_id == 当前用户，天生不支持共享。
 *   现在所有判定都走 MembershipService 查 workspace_member 表：
 *     - 查看：OWNER / EDITOR / VIEWER 都可以
 *     - 写（建/改/移/删）：OWNER / EDITOR
 *     - 管成员：OWNER
 *   文档不单独授权，一律继承所属空间的角色——层级越简单，越不容易出现漏判。
 *
 * 查不到记录时统一抛 403 而不是 404：不区分"不存在"和"不是你的"，
 * 避免被用来探测别人有哪些文档。
 */
@Service
public class DocumentService {

    private final WorkspaceRepository workspaceRepo;
    private final WorkspaceMemberRepository memberRepo;
    private final DocRepository docRepo;
    private final MembershipService membership;
    private final JwtService jwtService;

    public DocumentService(WorkspaceRepository workspaceRepo,
                           WorkspaceMemberRepository memberRepo,
                           DocRepository docRepo,
                           MembershipService membership,
                           JwtService jwtService) {
        this.workspaceRepo = workspaceRepo;
        this.memberRepo = memberRepo;
        this.docRepo = docRepo;
        this.membership = membership;
        this.jwtService = jwtService;
    }

    /* ---------------- 空间 ---------------- */

    /** 我能看到的所有空间：自己建的 + 被邀请加入的 */
    public List<WorkspaceDto> listWorkspaces(Long userId) {
        List<WorkspaceMember> mine = memberRepo.findByUserId(userId);
        if (mine.isEmpty()) {
            return List.of();
        }
        List<Long> ids = mine.stream().map(WorkspaceMember::getWorkspaceId).toList();
        var roleOf = new java.util.HashMap<Long, WorkspaceMember.Role>();
        mine.forEach(m -> roleOf.put(m.getWorkspaceId(), m.getRole()));

        return workspaceRepo.findAllById(ids).stream()
                .sorted(Comparator.comparingInt(Workspace::getSortOrder).thenComparing(Workspace::getId))
                .map(w -> toDto(w, roleOf.get(w.getId()), memberRepo.countByWorkspaceId(w.getId())))
                .toList();
    }

    /**
     * 新建空间。type=TEAM 即团队空间（可邀请成员共享）；
     * PERSONAL 是纯私人空间，成员接口会拒绝，保持"个人空间"的语义不被打穿。
     * kind 决定它出现在「文档库」还是「知识库」入口下，两者权限模型完全一致。
     */
    @Transactional
    public WorkspaceDto createWorkspace(String name, Workspace.Type type, Workspace.Kind kind, AuthUser owner) {
        Workspace w = new Workspace();
        w.setName(name == null || name.isBlank() ? "未命名空间" : name.trim());
        w.setType(type == null ? Workspace.Type.PERSONAL : type);
        w.setKind(kind == null ? Workspace.Kind.DOC : kind);
        w.setOwnerId(owner.id());
        w.setOwnerName(owner.displayName());
        w.setSortOrder((int) memberRepo.countByUserId(owner.id()));
        workspaceRepo.save(w);
        // 建空间的人自动是 OWNER，否则他自己都打不开
        membership.grantOwner(w.getId(), owner.id());
        return toDto(w, WorkspaceMember.Role.OWNER, 1);
    }

    /* ---------------- 文档 ---------------- */

    public List<DocDto> listDocs(Long workspaceId, Long userId) {
        membership.requireView(workspaceId, userId);
        List<Doc> all = docRepo.findByWorkspaceIdAndDeletedFalseOrderBySortOrderAscIdAsc(workspaceId);
        // 一次算完整棵树的章节号，前端拿到就能直接渲染，不必自己再拼一遍
        Map<Long, String> numbers = DocNumbers.of(all);
        return all.stream().map(d -> toDto(d, numbers.get(d.getId()))).toList();
    }

    public DocDto getDoc(Long id, Long userId) {
        return toDto(requireDoc(id, userId, false));
    }

    /**
     * 跨空间搜索文档标题 / 章节号。q 为空时退化成"最近更新"，主页直接复用这个接口。
     *
     * 只搜索「我加入的空间」，权限判定和列表一致，不会因为搜索绕过成员表。
     * 正文是 Yjs 二进制，没有全文索引，所以这里只匹配标题；纯数字查询额外匹配
     * 派生章节号（搜 1.1 会命中该章及其子文档），补上清理手写编号后的按号检索。
     */
    public List<DocHitDto> searchDocs(String q, int limit, Long userId) {
        List<Long> ids = memberRepo.findByUserId(userId).stream()
                .map(WorkspaceMember::getWorkspaceId)
                .toList();
        if (ids.isEmpty()) {
            return List.of();
        }

        String kw = q == null ? "" : q.trim().toLowerCase();
        int cap = Math.max(1, Math.min(limit <= 0 ? 20 : limit, 50));

        var nameOf = new java.util.HashMap<Long, String>();
        workspaceRepo.findAllById(ids).forEach(w -> nameOf.put(w.getId(), w.getName()));

        // 搜索本来就查了全部可见文档：直接用这批数据算编号，不用为每个结果再查一次树
        List<Doc> all = docRepo.findByWorkspaceIdInAndDeletedFalseOrderByUpdatedAtDesc(ids);
        Map<Long, String> numbers = DocNumbers.of(all);

        // 标题里手写的章节号清理掉之后，纯数字查询就直接匹配派生编号：
        // 搜「1.1」仍能找到该章节及其子文档，不会因为编号不落库而搜不到。
        boolean chapterQuery = kw.matches("\\d+(\\.\\d+)*");

        return all.stream()
                .filter(d -> {
                    if (kw.isEmpty()) return true;
                    if (d.getTitle() != null && d.getTitle().toLowerCase().contains(kw)) return true;
                    if (!chapterQuery) return false;
                    String n = numbers.get(d.getId());
                    return n != null && (n.equals(kw) || n.startsWith(kw + "."));
                })
                .limit(cap)
                .map(d -> new DocHitDto(
                        d.getId(), d.getTitle(), numbers.get(d.getId()), d.getWorkspaceId(),
                        nameOf.getOrDefault(d.getWorkspaceId(), ""), d.getParentId(), d.getUpdatedAt()))
                .toList();
    }

    /**
     * 新建文档。parentId 非空即为「子文档」，从而支持任意层级。
     * collabKey 用 UUID，作为 Yjs 房间名与落盘文件名。
     */
    @Transactional
    public DocDto createDoc(Long workspaceId, Long parentId, String title, Long userId) {
        membership.requireWrite(workspaceId, userId);
        if (parentId != null) {
            Doc parent = requireDoc(parentId, userId, true);
            if (!parent.getWorkspaceId().equals(workspaceId)) {
                throw new IllegalArgumentException("父文档不属于该空间");
            }
        }
        Doc d = new Doc();
        d.setWorkspaceId(workspaceId);
        d.setParentId(parentId);
        d.setTitle(title == null || title.isBlank() ? "无标题文档" : title.trim());
        d.setCollabKey(UUID.randomUUID().toString());
        d.setSortOrder(nextSortOrder(workspaceId, parentId));
        docRepo.save(d);
        return toDto(d);
    }

    @Transactional
    public DocDto renameDoc(Long id, String title, Long userId) {
        Doc d = requireDoc(id, userId, true);
        if (title != null && !title.isBlank()) {
            d.setTitle(title.trim());
        }
        d.setUpdatedAt(LocalDateTime.now());
        docRepo.save(d);
        return toDto(d);
    }

    /**
     * 移动文档（拖拽改层级 / 改顺序）。
     *
     * parentId 为新的父节点（null = 根）；index 为目标位置（在同级中的下标，null = 末尾）。
     * 落库时把目标父节点下的兄弟整体重新编号 1..n，这样前端拖拽只关心"插到第几个"，
     * 不需要自己算中间值，插入 N 次后 sortOrder 也不会膨胀。
     */
    @Transactional
    public DocDto moveDoc(Long id, Long parentId, Integer index, Long userId) {
        Doc d = requireDoc(id, userId, true);
        if (parentId != null) {
            if (parentId.equals(id)) {
                throw new IllegalArgumentException("不能把文档挂到自己下面");
            }
            Doc parent = requireDoc(parentId, userId, true);
            if (!parent.getWorkspaceId().equals(d.getWorkspaceId())) {
                throw new IllegalArgumentException("不能跨空间移动");
            }
            if (isDescendant(parentId, id)) {
                throw new IllegalArgumentException("不能移动到自己的子文档下（会形成环）");
            }
        }

        Long workspaceId = d.getWorkspaceId();
        d.setParentId(parentId);

        // 目标父节点下的其它兄弟（排除自己，避免重复插入）
        List<Doc> siblings = new ArrayList<>(docRepo
                .findByWorkspaceIdAndDeletedFalseOrderBySortOrderAscIdAsc(workspaceId).stream()
                .filter(x -> Objects.equals(x.getParentId(), parentId) && !x.getId().equals(id))
                .toList());

        int pos = index == null ? siblings.size() : Math.max(0, Math.min(index, siblings.size()));
        siblings.add(pos, d);
        for (int i = 0; i < siblings.size(); i++) {
            siblings.get(i).setSortOrder(i + 1);
        }
        docRepo.saveAll(siblings);
        return toDto(d);
    }

    /** 软删除整棵子树：元数据标记 deleted，协同二进制文件保留，便于恢复 */
    @Transactional
    public int deleteDoc(Long id, Long userId) {
        Doc root = requireDoc(id, userId, true);
        List<Doc> all = docRepo.findByWorkspaceIdAndDeletedFalse(root.getWorkspaceId());
        List<Long> toDelete = new ArrayList<>();
        Deque<Long> queue = new ArrayDeque<>();
        queue.add(id);
        while (!queue.isEmpty()) {
            Long cur = queue.poll();
            toDelete.add(cur);
            all.stream().filter(x -> cur.equals(x.getParentId())).forEach(x -> queue.add(x.getId()));
        }
        LocalDateTime now = LocalDateTime.now();
        all.stream()
                .filter(x -> toDelete.contains(x.getId()))
                .forEach(x -> { x.setDeleted(true); x.setUpdatedAt(now); });
        docRepo.saveAll(all);
        return toDelete.size();
    }

    /**
     * 撤销删除：把这篇文档以及它整棵子树里被标记删除的节点恢复回来。
     *
     * 删除本来就是软删（deleted 标记 + 协同 bin 保留），所以恢复不需要重建正文。
     * 唯一要处理的是「父级也被删了」的情况：那时挂回根节点，避免出现孤儿文档
     * ——挂着的父 id 找不到，前端会把它当成根节点渲染，位置会莫名其妙。
     */
    @Transactional
    public int restoreDoc(Long id, Long userId) {
        Doc root = docRepo.findById(id).orElseThrow(() -> new ForbiddenException("文档不存在：" + id));
        membership.requireWrite(root.getWorkspaceId(), userId);

        List<Doc> all = docRepo.findByWorkspaceId(root.getWorkspaceId());
        List<Long> subtree = new ArrayList<>();
        Deque<Long> queue = new ArrayDeque<>();
        queue.add(id);
        while (!queue.isEmpty()) {
            Long cur = queue.poll();
            subtree.add(cur);
            all.stream().filter(x -> cur.equals(x.getParentId())).forEach(x -> queue.add(x.getId()));
        }

        List<Doc> hit = all.stream()
                .filter(x -> subtree.contains(x.getId()) && x.isDeleted())
                .toList();

        LocalDateTime now = LocalDateTime.now();
        for (Doc d : hit) {
            d.setDeleted(false);
            d.setUpdatedAt(now);
        }
        if (root.isDeleted() && root.getParentId() != null) {
            Doc parent = docRepo.findById(root.getParentId()).orElse(null);
            if (parent == null || parent.isDeleted()) {
                root.setParentId(null);
            }
        }
        docRepo.saveAll(hit);
        return hit.size();
    }

    /**
     * 签发协同 token：只能用于这一个文档房间，且默认 2 小时过期。
     * 查看者同样能拿到——只读是在前端约束的，服务端没有强制拦截 Yjs 更新，
     * 这点在 README 里如实写明，不假装它是硬隔离。
     */
    public CollabTokenDto issueCollabToken(Long docId, AuthUser user) {
        Doc d = requireDoc(docId, user.id(), false);
        return new CollabTokenDto(jwtService.issueCollabToken(user, d.getCollabKey()),
                jwtService.collabTtlSeconds());
    }

    /* ---------------- 内部 ---------------- */

    /** 取文档并校验对所属空间的角色；write=true 时要求可写 */
    private Doc requireDoc(Long docId, Long userId, boolean write) {
        Doc d = docRepo.findByIdAndDeletedFalse(docId)
                .orElseThrow(() -> new ForbiddenException("文档不存在或无权访问：" + docId));
        if (write) {
            membership.requireWrite(d.getWorkspaceId(), userId);
        } else {
            membership.requireView(d.getWorkspaceId(), userId);
        }
        return d;
    }

    /** 同级排序号，从 1 开始 */
    private int nextSortOrder(Long workspaceId, Long parentId) {
        return docRepo.findByWorkspaceIdAndDeletedFalseOrderBySortOrderAscIdAsc(workspaceId).stream()
                .filter(x -> Objects.equals(x.getParentId(), parentId))
                .mapToInt(Doc::getSortOrder).max().orElse(0) + 1;
    }

    /** candidate 是否在 ancestorId 的子树内（用于防止移动成环） */
    private boolean isDescendant(Long candidateId, Long ancestorId) {
        Long cur = candidateId;
        int guard = 0;
        while (cur != null && guard++ < 200) {
            if (cur.equals(ancestorId)) return true;
            Doc d = docRepo.findById(cur).orElse(null);
            cur = d == null ? null : d.getParentId();
        }
        return false;
    }

    /**
     * 单篇返回（get / 新建 / 改名 / 移动）也要带上章节号。
     * 移动会同时改掉兄弟节点的 sortOrder，所以必须按「当前库里的最新结构」重算，
     * 不能用移动前的旧位置——否则刚拖完返回的那一篇编号是错的。
     */
    private DocDto toDto(Doc d) {
        List<Doc> all = docRepo.findByWorkspaceIdAndDeletedFalseOrderBySortOrderAscIdAsc(d.getWorkspaceId());
        return toDto(d, DocNumbers.of(all).get(d.getId()));
    }

    private DocDto toDto(Doc d, String number) {
        return new DocDto(d.getId(), d.getWorkspaceId(), d.getParentId(),
                d.getTitle(), number, d.getCollabKey(), d.getSortOrder(), d.getUpdatedAt());
    }

    private WorkspaceDto toDto(Workspace w, WorkspaceMember.Role role, long memberCount) {
        return new WorkspaceDto(w.getId(), w.getName(), w.getType().name(), w.getKind().name(),
                w.getOwnerName(), role == null ? null : role.name(), memberCount);
    }
}
