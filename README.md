# Agent State Snapshot

A robust tool for capturing, restoring, and managing the complete state of AI agents. Designed for reliability, debugging, and rollback capabilities in autonomous agent systems.

## Features

- 📸 **Atomic Snapshots**: Capture memory, context, tasks, and tool history in a single atomic operation.
- 🔄 **State Restoration**: Instant restoration of agent state from any point in time.
- ⏪ **Undo/Redo**: Built-in `RollbackManager` for linear history management.
- 📦 **Efficient Storage**: Automatic GZIP compression and checksum verification.
- 🔍 **State Diffing**: Compare snapshots to see exactly what changed in memory or tasks.
- 📤 **Import/Export**: Portable snapshot files for debugging across environments.
- 🧹 **Auto-Pruning**: Keep storage lean with automatic cleanup of old snapshots.

## Installation

```bash
bun add agent-state-snapshot
```

## Quick Start

```typescript
import { SnapshotManager, FileStorageProvider, StateBuilder } from "agent-state-snapshot";

// 1. Setup storage and manager
const storage = new FileStorageProvider("./snapshots/data");
const manager = new SnapshotManager("my-agent", storage, {
  compression: true,
  basePath: "./snapshots"
});
await manager.init();

// 2. Build current state
const builder = new StateBuilder("persona-expert");
const currentState = builder
  .setMemory({ mood: "helpful", tokens: 1500 })
  .addMessage("user", "What is the capital of France?")
  .addTask("task-research", "Research European capitals")
  .build();

// 3. Take snapshot
const meta = await manager.takeSnapshot(currentState, "Pre-response checkpoint");

// 4. Restore later
const oldState = await manager.restoreSnapshot(meta.id);
console.log(oldState.memory.mood); // "helpful"
```

## Architecture

### AgentState Structure
Every snapshot captures a comprehensive state object:
- `version`: Schema versioning.
- `timestamp`: Creation time.
- `personaId`: Identity reference.
- `memory`: Custom key-value store.
- `context`: Full message history and variables.
- `activeTasks`: Tracked goals and their progress.
- `toolHistory`: Audit trail of tool calls and results.

### Components
- **SnapshotManager**: Primary API for saving/loading.
- **StorageProvider**: Pluggable storage (Defaults to `FileStorageProvider`).
- **RollbackManager**: High-level undo/redo interface.
- **StateBuilder**: Fluent API for constructing state objects.

## Quality Standards

- **Integrity**: Every snapshot is verified with a SHA-256 checksum on load.
- **Safety**: Compression reduces disk footprint by up to 90% for text-heavy states.
- **Flexibility**: Tagging system allows for categorical snapshots (e.g., "milestone", "error", "user-requested").

## License

MIT
