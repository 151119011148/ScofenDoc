package com.scofendoc.config;

import com.scofendoc.entity.Doc;
import com.scofendoc.entity.Workspace;
import com.scofendoc.entity.WorkspaceMember;
import com.scofendoc.repository.DocRepository;
import com.scofendoc.repository.WorkspaceMemberRepository;
import com.scofendoc.repository.WorkspaceRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * 启动时的数据准备，做两件事：
 *
 * 1) 首次启动（空间表为空）写入演示空间与文档。
 *    其中根文档 "Demo 协同文档" 的 collabKey 固定为 demo-doc，
 *    这样上线前用旧版 Demo 写过的内容（协同服务里已落盘的 demo-doc.bin）能直接延续。
 *
 * 2) **回填成员表**。加入团队共享后，权限判定从 owner_id 改为查 workspace_member；
 *    老空间没有成员行，升级后连所有者自己都会被判 403。所以每次启动都幂等补一遍。
 */
@Component
public class DataSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(DataSeeder.class);

    private final WorkspaceRepository workspaceRepo;
    private final DocRepository docRepo;
    private final WorkspaceMemberRepository memberRepo;

    public DataSeeder(WorkspaceRepository workspaceRepo, DocRepository docRepo,
                      WorkspaceMemberRepository memberRepo) {
        this.workspaceRepo = workspaceRepo;
        this.docRepo = docRepo;
        this.memberRepo = memberRepo;
    }

    @Override
    public void run(String... args) {
        if (workspaceRepo.count() == 0) {
            seedDemo();
        }
        backfillMembers();
    }

    /** 幂等：给已有 owner 但没有成员行的空间补 OWNER 成员行 */
    private void backfillMembers() {
        int fixed = 0;
        for (Workspace w : workspaceRepo.findAll()) {
            Long ownerId = w.getOwnerId();
            if (ownerId == null) {
                // 无主空间留给首个注册用户认领，认领时会写成员行
                continue;
            }
            if (memberRepo.existsByWorkspaceIdAndUserId(w.getId(), ownerId)) {
                continue;
            }
            WorkspaceMember m = new WorkspaceMember();
            m.setWorkspaceId(w.getId());
            m.setUserId(ownerId);
            m.setRole(WorkspaceMember.Role.OWNER);
            memberRepo.save(m);
            fixed++;
        }
        if (fixed > 0) {
            log.info("已为 {} 个历史空间补写所有者成员行", fixed);
        }
    }

    private void seedDemo() {
        Workspace personal = new Workspace();
        personal.setName("我的空间");
        personal.setType(Workspace.Type.PERSONAL);
        personal.setOwnerName("本机用户");
        personal.setSortOrder(0);
        workspaceRepo.save(personal);

        Workspace team = new Workspace();
        team.setName("团队空间");
        team.setType(Workspace.Type.TEAM);
        team.setOwnerName("本机用户");
        team.setSortOrder(1);
        workspaceRepo.save(team);

        // 根文档：沿用旧 demo 房间，保证老内容不丢
        Doc demo = new Doc();
        demo.setWorkspaceId(personal.getId());
        demo.setParentId(null);
        demo.setTitle("Demo 协同文档");
        demo.setCollabKey("demo-doc");
        demo.setSortOrder(1);
        docRepo.save(demo);

        // 子文档：演示父子层级
        Doc child = new Doc();
        child.setWorkspaceId(personal.getId());
        child.setParentId(demo.getId());
        child.setTitle("子文档示例（父子层级）");
        child.setCollabKey(UUID.randomUUID().toString());
        child.setSortOrder(1);
        docRepo.save(child);

        Doc draft = new Doc();
        draft.setWorkspaceId(personal.getId());
        draft.setParentId(null);
        draft.setTitle("产品需求草案");
        draft.setCollabKey(UUID.randomUUID().toString());
        draft.setSortOrder(2);
        docRepo.save(draft);

        log.info("种子数据已创建：空间 2 个，文档 3 篇");
    }
}
