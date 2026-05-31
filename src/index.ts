import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Represents the state of an AI agent at a specific point in time.
 */
export interface AgentState {
  version: string;
  timestamp: number;
  personaId: string;
  memory: Record<string, any>;
  context: {
    messages: Array<{ role: string; content: string; [key: string]: any }>;
    variables: Record<string, any>;
  };
  activeTasks: Array<{
    id: string;
    description: string;
    status: "pending" | "running" | "suspended";
    progress: number;
    metadata: Record<string, any>;
  }>;
  toolHistory: Array<{
    tool: string;
    args: any;
    result: any;
    timestamp: number;
  }>;
  metadata: Record<string, any>;
}

/**
 * Metadata for a saved snapshot.
 */
export interface SnapshotMetadata {
  id: string;
  agentId: string;
  timestamp: number;
  label?: string;
  checksum: string;
  tags: string[];
  size: number;
}

/**
 * Storage provider interface for snapshots.
 */
export interface StorageProvider {
  save(id: string, data: Buffer): Promise<void>;
  load(id: string): Promise<Buffer>;
  list(): Promise<string[]>;
  delete(id: string): Promise<void>;
  exists(id: string): Promise<boolean>;
}

/**
 * Local filesystem storage provider.
 */
export class FileStorageProvider implements StorageProvider {
  constructor(private baseDir: string) {}

  async ensureDir() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async save(id: string, data: Buffer): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(join(this.baseDir, `${id}.bin`), data);
  }

  async load(id: string): Promise<Buffer> {
    return Buffer.from(await fs.readFile(join(this.baseDir, `${id}.bin`)));
  }

  async list(): Promise<string[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.baseDir);
    return files.filter(f => f.endsWith(".bin")).map(f => f.replace(".bin", ""));
  }

  async delete(id: string): Promise<void> {
    await fs.unlink(join(this.baseDir, `${id}.bin`));
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(join(this.baseDir, `${id}.bin`));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Core manager for agent state snapshots.
 */
export class SnapshotManager {
  private snapshots: Map<string, SnapshotMetadata> = new Map();
  private metadataPath: string;

  constructor(
    private agentId: string,
    private storage: StorageProvider,
    private options: {
      compression?: boolean;
      encryption?: { key: string; algorithm: string };
      basePath: string;
    }
  ) {
    this.metadataPath = join(options.basePath, "metadata.json");
  }

  /**
   * Initialize the manager by loading existing metadata.
   */
  async init() {
    try {
      const data = await fs.readFile(this.metadataPath, "utf-8");
      const metaArray: SnapshotMetadata[] = JSON.parse(data);
      for (const meta of metaArray) {
        this.snapshots.set(meta.id, meta);
      }
    } catch {
      // No metadata file yet
    }
  }

  private async saveMetadata() {
    const metaArray = Array.from(this.snapshots.values());
    await fs.writeFile(this.metadataPath, JSON.stringify(metaArray, null, 2));
  }

  /**
   * Captures the current state and saves it as a snapshot.
   */
  async takeSnapshot(state: AgentState, label?: string, tags: string[] = []): Promise<SnapshotMetadata> {
    const id = randomUUID();
    let data = Buffer.from(JSON.stringify(state));

    if (this.options.compression) {
      data = Buffer.from(gzipSync(data));
    }

    const checksum = createHash("sha256").update(data).digest("hex");

    await this.storage.save(id, data);

    const metadata: SnapshotMetadata = {
      id,
      agentId: this.agentId,
      timestamp: Date.now(),
      label,
      checksum,
      tags,
      size: data.length
    };

    this.snapshots.set(id, metadata);
    await this.saveMetadata();

    return metadata;
  }

  /**
   * Restores a state from a snapshot.
   */
  async restoreSnapshot(id: string): Promise<AgentState> {
    const metadata = this.snapshots.get(id);
    if (!metadata) {
      throw new Error(`Snapshot ${id} not found`);
    }

    let data = await this.storage.load(id);
    const checksum = createHash("sha256").update(data).digest("hex");

    if (checksum !== metadata.checksum) {
      throw new Error(`Checksum mismatch for snapshot ${id}. Data may be corrupted.`);
    }

    if (this.options.compression) {
      data = Buffer.from(gunzipSync(data));
    }

    return JSON.parse(data.toString());
  }

  /**
   * Lists all available snapshots for this agent.
   */
  listSnapshots(): SnapshotMetadata[] {
    return Array.from(this.snapshots.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Deletes a snapshot.
   */
  async deleteSnapshot(id: string): Promise<void> {
    if (!this.snapshots.has(id)) return;
    await this.storage.delete(id);
    this.snapshots.delete(id);
    await this.saveMetadata();
  }

  /**
   * Finds snapshots by tag.
   */
  findSnapshotsByTag(tag: string): SnapshotMetadata[] {
    return this.listSnapshots().filter(s => s.tags.includes(tag));
  }

  /**
   * Compares two snapshots and returns a diff report.
   */
  async diffSnapshots(idA: string, idB: string) {
    const stateA = await this.restoreSnapshot(idA);
    const stateB = await this.restoreSnapshot(idB);

    return {
      timestampDiff: stateB.timestamp - stateA.timestamp,
      memoryChanged: JSON.stringify(stateA.memory) !== JSON.stringify(stateB.memory),
      messageCountDiff: stateB.context.messages.length - stateA.context.messages.length,
      newTasks: stateB.activeTasks.filter(tb => !stateA.activeTasks.find(ta => ta.id === tb.id)),
      completedTasks: stateA.activeTasks.filter(ta => !stateB.activeTasks.find(tb => tb.id === ta.id)),
      toolExecutions: stateB.toolHistory.length - stateA.toolHistory.length
    };
  }

  /**
   * Prunes old snapshots, keeping only the N most recent.
   */
  async prune(keepRecent: number) {
    const sorted = this.listSnapshots();
    if (sorted.length <= keepRecent) return;

    const toDelete = sorted.slice(keepRecent);
    for (const snap of toDelete) {
      await this.deleteSnapshot(snap.id);
    }
  }

  /**
   * Exports a snapshot as a standalone file.
   */
  async exportSnapshot(id: string, filePath: string) {
    const metadata = this.snapshots.get(id);
    if (!metadata) throw new Error("Snapshot not found");
    
    const data = await this.storage.load(id);
    const exportData = {
      metadata,
      data: data.toString("base64")
    };

    await fs.writeFile(filePath, JSON.stringify(exportData, null, 2));
  }

  /**
   * Imports a snapshot from an export file.
   */
  async importSnapshot(filePath: string): Promise<SnapshotMetadata> {
    const raw = await fs.readFile(filePath, "utf-8");
    const { metadata, data } = JSON.parse(raw);
    
    const buffer = Buffer.from(data, "base64");
    await this.storage.save(metadata.id, buffer);
    
    this.snapshots.set(metadata.id, metadata);
    await this.saveMetadata();
    
    return metadata;
  }
}

/**
 * Utility class for creating state objects.
 */
export class StateBuilder {
  private state: AgentState;

  constructor(personaId: string) {
    this.state = {
      version: "1.0.0",
      timestamp: Date.now(),
      personaId,
      memory: {},
      context: { messages: [], variables: {} },
      activeTasks: [],
      toolHistory: [],
      metadata: {}
    };
  }

  setMemory(memory: Record<string, any>) {
    this.state.memory = memory;
    return this;
  }

  addMessage(role: string, content: string, metadata: Record<string, any> = {}) {
    this.state.context.messages.push({ role, content, ...metadata });
    return this;
  }

  addTask(id: string, description: string, status: "pending" | "running" | "suspended" = "pending") {
    this.state.activeTasks.push({ id, description, status, progress: 0, metadata: {} });
    return this;
  }

  addToolExecution(tool: string, args: any, result: any) {
    this.state.toolHistory.push({ tool, args, result, timestamp: Date.now() });
    return this;
  }

  build(): AgentState {
    this.state.timestamp = Date.now();
    return this.state;
  }
}

/**
 * Rollback Manager provides high-level undo/redo functionality using snapshots.
 */
export class RollbackManager {
  private history: string[] = [];
  private currentIndex: number = -1;

  constructor(private manager: SnapshotManager) {}

  async checkpoint(state: AgentState, label?: string) {
    const snap = await this.manager.takeSnapshot(state, label, ["rollback-checkpoint"]);
    
    // If we're not at the end of history, clear the "forward" history
    if (this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }
    
    this.history.push(snap.id);
    this.currentIndex++;
  }

  async undo(): Promise<AgentState | null> {
    if (this.currentIndex <= 0) return null;
    this.currentIndex--;
    return this.manager.restoreSnapshot(this.history[this.currentIndex]);
  }

  async redo(): Promise<AgentState | null> {
    if (this.currentIndex >= this.history.length - 1) return null;
    this.currentIndex++;
    return this.manager.restoreSnapshot(this.history[this.currentIndex]);
  }

  getHistory() {
    return this.history.map(id => this.manager.listSnapshots().find(s => s.id === id));
  }
}
