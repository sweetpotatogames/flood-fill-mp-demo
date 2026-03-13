# Flood-Fill Dungeon Generator — Multiplayer PoC

A TypeScript proof-of-concept for a **lazy, flood-fill dungeon generator** designed for multiplayer games.  
The dungeon has no fixed size — it grows in real time as players explore.

## Quick Start

```bash
npm install
npm run build
npm start
# → Server running at http://localhost:3000
```

Open **multiple browser tabs** to simulate multiple players.  
Use **WASD** or **arrow keys** to move.

## How the Algorithm Works

### Core idea

The dungeon is an infinite 2D grid.  No room exists until a player gets close.  
When a player steps into a room, a **BFS flood-fill** runs outward, guaranteeing that
all rooms within **2 hops** are generated before the player can reach them.

```
Player at ★ — rooms marked with their hop distance:

        [2] [2] [2]
        [2] [1] [2]
        [2] [1] [2]
        [2] ★  [2]
        [2] [1] [2]
        [2] [2] [2]
```

Rooms inside the radius become **frontier** (generated, not yet visited).  
Rooms the player has walked into become **explored**.

### Deterministic layout

Every room's exits are computed from a hash of its coordinates, so:

- The same `(x, y)` always produces the same exits.  
- `hasPassage(A, B) === hasPassage(B, A)` — both sides of a wall always agree.
- No global state is needed; rooms can be generated in any order.

```typescript
function hasPassage(ax, ay, bx, by): boolean {
  // Canonical ordering → same result regardless of which side asks
  const h = hash32(x1 * 83492791 ^ y1 * 73856093 ^ x2 * 15485863 ^ y2 * 19349663);
  return (h % 100) < 65;   // 65 % of walls are open
}
```

### Multiplayer sync

- Server holds the single source of truth (`rooms`, `players`, `explored`, `frontier`).
- Every player move triggers `floodGenerate()` then broadcasts the full state to all clients.
- New rooms flash blue on all screens so players can see the dungeon expanding.

## Porting to Godot

The algorithm maps cleanly to GDScript:

| TypeScript concept       | Godot equivalent                          |
|--------------------------|-------------------------------------------|
| `Map<string, Room>`      | `Dictionary` keyed by `Vector2i`          |
| `floodGenerate(x,y,r)`   | BFS using `Array` as queue                |
| `hasPassage(a,b)`        | Pure function, same hash logic            |
| WebSocket broadcast      | `MultiplayerSynchronizer` or `ENetMultiplayer` |
| `explored` / `frontier`  | Two `Dictionary` sets on the server       |

**Recommended Godot architecture:**
1. Run the dungeon generator **only on the server** (authority node).
2. Replicate only the `rooms` dict and `players` dict to clients.
3. Call `floodGenerate` on `_on_player_moved` (server-side).
4. Clients render whatever rooms they receive — no generation logic needed client-side.

## File Layout

```
server.ts          — WebSocket server + dungeon generation logic
public/index.html  — Canvas renderer + keyboard input client
package.json
tsconfig.json
```

## Tuning

| Constant              | Location     | Effect                                      |
|-----------------------|--------------|---------------------------------------------|
| `GENERATION_RADIUS`   | `server.ts`  | Rooms pre-generated ahead of each player    |
| `hasPassage` threshold| `server.ts`  | 65 = open dungeon, lower = more dead ends   |
| `CELL` / `ROOM`       | `index.html` | Visual scale of the rendered grid           |
| `LERP_SPEED`          | `index.html` | Camera smoothing (0 = instant, 1 = no lerp) |
