import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { SnapshotManager, FileStorageProvider, StateBuilder, RollbackManager } from "../src/index";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, "test-snapshots");

describe("SnapshotManager", () => {
  let storage: FileStorageProvider;
  let manager: SnapshotManager;

  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    storage = new FileStorageProvider(join(TEST_DIR, "data"));
    manager = new SnapshotManager("test-agent", storage, {
      compression: true,
      basePath: TEST_DIR
    });
    await manager.init();
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("should take and restore a snapshot", async () => {
    const builder = new StateBuilder("persona-1");
    const state = builder
      .setMemory({ user: "thebookmaster", level: 10 })
      .addMessage("user", "Hello")
      .addMessage("assistant", "Hi there!")
      .addTask("task-1", "Build a snapshot tool")
      .addToolExecution("bash", { cmd: "ls" }, "file1.txt")
      .build();

    const meta = await manager.takeSnapshot(state, "Initial State", ["test"]);
    expect(meta.label).toBe("Initial State");
    expect(meta.tags).toContain("test");

    const restored = await manager.restoreSnapshot(meta.id);
    expect(restored.personaId).toBe("persona-1");
    expect(restored.memory.user).toBe("thebookmaster");
    expect(restored.context.messages.length).toBe(2);
    expect(restored.activeTasks.length).toBe(1);
    expect(restored.toolHistory.length).toBe(1);
  });

  test("should list and delete snapshots", async () => {
    const builder = new StateBuilder("persona-1");
    const s1 = await manager.takeSnapshot(builder.build(), "Snap 1");
    const s2 = await manager.takeSnapshot(builder.build(), "Snap 2");

    const list = manager.listSnapshots();
    expect(list.length).toBeGreaterThanOrEqual(2);
    
    await manager.deleteSnapshot(s1.id);
    const newList = manager.listSnapshots();
    expect(newList.find(s => s.id === s1.id)).toBeUndefined();
  });

  test("should diff snapshots", async () => {
    const builder = new StateBuilder("persona-1");
    const state1 = builder.setMemory({ count: 1 }).build();
    const meta1 = await manager.takeSnapshot(state1);

    const state2 = new StateBuilder("persona-1")
      .setMemory({ count: 2 })
      .addTask("new-task", "something")
      .build();
    const meta2 = await manager.takeSnapshot(state2);

    const diff = await manager.diffSnapshots(meta1.id, meta2.id);
    expect(diff.memoryChanged).toBe(true);
    expect(diff.newTasks.length).toBe(1);
  });

  test("should handle rollback (undo/redo)", async () => {
    const rollback = new RollbackManager(manager);
    const b = () => new StateBuilder("persona-1");

    await rollback.checkpoint(b().setMemory({ step: 1 }).build());
    await rollback.checkpoint(b().setMemory({ step: 2 }).build());
    await rollback.checkpoint(b().setMemory({ step: 3 }).build());

    const state2 = await rollback.undo();
    expect(state2?.memory.step).toBe(2);

    const state1 = await rollback.undo();
    expect(state1?.memory.step).toBe(1);

    const state2Again = await rollback.redo();
    expect(state2Again?.memory.step).toBe(2);
  });

  test("should prune snapshots", async () => {
    for (let i = 0; i < 5; i++) {
      await manager.takeSnapshot(new StateBuilder("p").build());
    }
    
    await manager.prune(2);
    expect(manager.listSnapshots().length).toBeLessThanOrEqual(2);
  });

  test("should export and import snapshots", async () => {
    const state = new StateBuilder("persona-export").build();
    const meta = await manager.takeSnapshot(state);
    
    const exportPath = join(TEST_DIR, "export.json");
    await manager.exportSnapshot(meta.id, exportPath);
    
    // Delete existing
    await manager.deleteSnapshot(meta.id);
    
    const imported = await manager.importSnapshot(exportPath);
    expect(imported.id).toBe(meta.id);
    
    const restored = await manager.restoreSnapshot(imported.id);
    expect(restored.personaId).toBe("persona-export");
  });
});
