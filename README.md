# Flood-Fill Dungeon Generator — Multiplayer PoC

A TypeScript proof-of-concept for a **lazy, room-template flood-fill dungeon generator** designed for multiplayer games.
The dungeon has no fixed size — it grows in real time as players explore, placing **multi-cell room templates** (tetromino-like shapes) that connect through doors.

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

The dungeon uses a cell grid as its spatial backbone. Each **room** is a **template** occupying multiple grid cells (L-shapes, T-shapes, corridors, halls). Rooms connect through **connectors** — doors on specific cell edges.

Players move cell-by-cell. Movement within a room is free; crossing between rooms requires stepping through a linked connector (door). When a player enters a new room, a **BFS flood-fill** generates rooms at unlinked connectors up to 2 hops ahead.

### Room Templates

~15 pre-authored templates including all rotational variants:

| Template | Cells | Description |
|----------|-------|-------------|
| `hub_1x1` | 1 | Single cell with 4 connectors (crossroads) |
| `corr_h`, `corr_v` | 2 | Short corridors (horizontal/vertical) |
| `long_h`, `long_v` | 3 | Long corridors |
| `L_0` – `L_270` | 3 | L-shapes (4 rotations) |
| `T_0` – `T_270` | 4 | T-shapes (4 rotations) |
| `sq_2x2` | 4 | Square room |
| `hall_3x3` | 9 | Large hall (hub room) |
| `dead_n/s/e/w` | 1 | Dead-end fallback (single connector) |

### Placement algorithm

When the flood-fill reaches an unlinked connector:

1. Compute the **target cell** on the other side of the connector
2. If already occupied, try to link back-connectors between rooms
3. Generate a **deterministic seed** from the world position + face direction
4. Build a **candidate list** of (template, connectorIdx) pairs with matching opposite face
5. **Shuffle candidates** using the seed, try each — first fit with no cell overlaps wins
6. If nothing fits, place a 1×1 **dead-end fallback**

### Deterministic layout

Template selection is seeded from `hash32(cellX * 83492791 ^ cellY * 73856093 ^ FACE_HASH[face])`, depending only on world position + face direction. The same exploration produces the same layout regardless of which player discovers it first.

### Multiplayer sync

- Server holds the single source of truth (`roomGraph`, `cellToRoom`, `players`, `explored`, `frontier`)
- Every player move triggers `floodGenerateRooms()` then broadcasts full state to all clients
- New rooms flash blue on all screens so players can see the dungeon expanding
- Gap-filling generates corridors between nearby players via greedy best-first search

## Porting to Godot

The algorithm maps cleanly to GDScript:

| TypeScript concept       | Godot equivalent                          |
|--------------------------|-------------------------------------------|
| `RoomTemplate` interface | `Resource` subclass with cell/connector arrays |
| `Map<string, PlacedRoom>` | `Dictionary` keyed by room ID |
| `cellToRoom` Map         | `Dictionary` keyed by `Vector2i`          |
| `floodGenerateRooms()`   | BFS using `Array` as queue                |
| `placeRoomAtConnector()` | Same overlap-check + seeded shuffle logic |
| WebSocket broadcast      | `MultiplayerSynchronizer` or `ENetMultiplayer` |

**Recommended Godot architecture:**
1. Run the dungeon generator **only on the server** (authority node).
2. Replicate only the room graph and player state to clients.
3. Call `floodGenerateRooms` on `_on_player_moved` (server-side).
4. Clients render whatever rooms they receive — no generation logic needed client-side.

## File Layout

```
server.ts          — WebSocket server + room template dungeon generation
public/index.html  — Canvas renderer + keyboard input client
package.json
tsconfig.json
```

## Tuning

| Constant              | Location     | Effect                                      |
|-----------------------|--------------|---------------------------------------------|
| `GENERATION_RADIUS`   | `server.ts`  | Room-graph hops pre-generated ahead of player |
| `GAP_FILL_THRESHOLD`  | `server.ts`  | Max Chebyshev distance for inter-player gap fill |
| `GAP_FILL_MAX_STEPS`  | `server.ts`  | Cap on greedy fill iterations |
| Template `weight`     | `server.ts`  | Selection bias per template (higher = more likely) |
| `CELL`                | `index.html` | Visual scale of the rendered grid (px per cell) |
| `LERP`                | `index.html` | Camera smoothing (lower = smoother) |
