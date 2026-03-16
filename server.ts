import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────

type Direction = 'n' | 's' | 'e' | 'w';
type RoomType  = 'empty' | 'treasure' | 'monster' | 'trap' | 'shrine' | 'spawn';

const DIR_OFFSETS: Record<Direction, [number, number]> = {
  n: [0, -1],  s: [0, 1],  e: [1, 0],  w: [-1, 0],
};
const OPPOSITE: Record<Direction, Direction> = { n: 's', s: 'n', e: 'w', w: 'e' };
const FACE_HASH: Record<Direction, number> = { n: 1, s: 2, e: 3, w: 4 };

interface Connector {
  cellOffset: [number, number];
  face: Direction;
}

interface RoomTemplate {
  id: string;
  cells: [number, number][];
  connectors: Connector[];
  weight: number;
}

interface WorldConnector {
  cellX: number;
  cellY: number;
  face: Direction;
  linkedRoomId: string | null;
}

interface PlacedRoom {
  roomId: string;
  templateId: string;
  anchorX: number;
  anchorY: number;
  worldCells: Set<string>;
  connectors: WorldConnector[];
  type: RoomType;
}

interface Player {
  id: string;
  x: number;
  y: number;
  color: string;
  name: string;
  currentRoomId: string;
  explored: Set<string>;  // roomIds this player has walked into
}

interface SerialPlayer {
  id: string;
  x: number;
  y: number;
  color: string;
  name: string;
}

// ─────────────────────────────────────────────
//  Hash helpers — deterministic world
// ─────────────────────────────────────────────

function hash32(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return Math.abs(h ^ (h >>> 16));
}

/** Seeded shuffle (Fisher-Yates) — returns a new array. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = hash32(s);
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─────────────────────────────────────────────
//  Room Templates (~15 pre-authored shapes)
// ─────────────────────────────────────────────

const TEMPLATES: RoomTemplate[] = [
  // ── 1×1 dead-end (single connector, used as fallback) ──
  { id: 'dead_n', cells: [[0,0]], connectors: [{ cellOffset:[0,0], face:'n' }], weight: 0 },
  { id: 'dead_s', cells: [[0,0]], connectors: [{ cellOffset:[0,0], face:'s' }], weight: 0 },
  { id: 'dead_e', cells: [[0,0]], connectors: [{ cellOffset:[0,0], face:'e' }], weight: 0 },
  { id: 'dead_w', cells: [[0,0]], connectors: [{ cellOffset:[0,0], face:'w' }], weight: 0 },

  // ── 1×1 hub (all 4 connectors) ──
  { id: 'hub_1x1', cells: [[0,0]], connectors: [
    { cellOffset:[0,0], face:'n' }, { cellOffset:[0,0], face:'s' },
    { cellOffset:[0,0], face:'e' }, { cellOffset:[0,0], face:'w' },
  ], weight: 5 },

  // ── 1×2 corridor (horizontal) ──
  { id: 'corr_h', cells: [[0,0],[1,0]], connectors: [
    { cellOffset:[0,0], face:'w' }, { cellOffset:[1,0], face:'e' },
    { cellOffset:[0,0], face:'n' }, { cellOffset:[1,0], face:'s' },
  ], weight: 8 },

  // ── 1×2 corridor (vertical) ──
  { id: 'corr_v', cells: [[0,0],[0,1]], connectors: [
    { cellOffset:[0,0], face:'n' }, { cellOffset:[0,1], face:'s' },
    { cellOffset:[0,0], face:'w' }, { cellOffset:[0,1], face:'e' },
  ], weight: 8 },

  // ── 1×3 long corridor (horizontal) ──
  { id: 'long_h', cells: [[0,0],[1,0],[2,0]], connectors: [
    { cellOffset:[0,0], face:'w' }, { cellOffset:[2,0], face:'e' },
    { cellOffset:[1,0], face:'n' }, { cellOffset:[1,0], face:'s' },
  ], weight: 4 },

  // ── 1×3 long corridor (vertical) ──
  { id: 'long_v', cells: [[0,0],[0,1],[0,2]], connectors: [
    { cellOffset:[0,0], face:'n' }, { cellOffset:[0,2], face:'s' },
    { cellOffset:[0,1], face:'w' }, { cellOffset:[0,1], face:'e' },
  ], weight: 4 },

  // ── L-shapes (4 rotations, 3 cells) ──
  { id: 'L_0', cells: [[0,0],[1,0],[1,1]], connectors: [
    { cellOffset:[0,0], face:'w' }, { cellOffset:[0,0], face:'n' },
    { cellOffset:[1,1], face:'s' }, { cellOffset:[1,1], face:'e' },
  ], weight: 6 },
  { id: 'L_90', cells: [[0,0],[0,1],[1,0]], connectors: [
    { cellOffset:[0,1], face:'w' }, { cellOffset:[0,1], face:'s' },
    { cellOffset:[1,0], face:'e' }, { cellOffset:[1,0], face:'n' },
  ], weight: 6 },
  { id: 'L_180', cells: [[0,0],[0,1],[1,1]], connectors: [
    { cellOffset:[0,0], face:'n' }, { cellOffset:[0,0], face:'w' },
    { cellOffset:[1,1], face:'e' }, { cellOffset:[1,1], face:'s' },
  ], weight: 6 },
  { id: 'L_270', cells: [[0,0],[1,0],[1,-1]], connectors: [
    { cellOffset:[0,0], face:'w' }, { cellOffset:[0,0], face:'s' },
    { cellOffset:[1,-1], face:'e' }, { cellOffset:[1,-1], face:'n' },
  ], weight: 6 },

  // ── T-shapes (4 rotations, 4 cells) ──
  { id: 'T_0', cells: [[0,0],[1,0],[2,0],[1,1]], connectors: [
    { cellOffset:[0,0], face:'w' }, { cellOffset:[2,0], face:'e' },
    { cellOffset:[0,0], face:'n' }, { cellOffset:[1,1], face:'s' },
  ], weight: 4 },
  { id: 'T_90', cells: [[0,0],[0,1],[0,2],[1,1]], connectors: [
    { cellOffset:[0,0], face:'n' }, { cellOffset:[0,2], face:'s' },
    { cellOffset:[0,0], face:'w' }, { cellOffset:[1,1], face:'e' },
  ], weight: 4 },
  { id: 'T_180', cells: [[0,0],[1,0],[2,0],[1,-1]], connectors: [
    { cellOffset:[0,0], face:'w' }, { cellOffset:[2,0], face:'e' },
    { cellOffset:[1,-1], face:'n' }, { cellOffset:[1,0], face:'s' },
  ], weight: 4 },
  { id: 'T_270', cells: [[0,0],[0,1],[0,2],[-1,1]], connectors: [
    { cellOffset:[0,0], face:'n' }, { cellOffset:[0,2], face:'s' },
    { cellOffset:[-1,1], face:'w' }, { cellOffset:[0,1], face:'e' },
  ], weight: 4 },

  // ── 2×2 square room ──
  { id: 'sq_2x2', cells: [[0,0],[1,0],[0,1],[1,1]], connectors: [
    { cellOffset:[0,0], face:'n' }, { cellOffset:[1,0], face:'n' },
    { cellOffset:[0,1], face:'s' }, { cellOffset:[1,1], face:'s' },
    { cellOffset:[0,0], face:'w' }, { cellOffset:[0,1], face:'w' },
    { cellOffset:[1,0], face:'e' }, { cellOffset:[1,1], face:'e' },
  ], weight: 3 },

  // ── 3×3 hall (big hub) ──
  { id: 'hall_3x3', cells: [
    [0,0],[1,0],[2,0],
    [0,1],[1,1],[2,1],
    [0,2],[1,2],[2,2],
  ], connectors: [
    { cellOffset:[1,0], face:'n' },
    { cellOffset:[1,2], face:'s' },
    { cellOffset:[0,1], face:'w' },
    { cellOffset:[2,1], face:'e' },
  ], weight: 1 },
];

// Index: for each face direction, which (template, connectorIdx) pairs have a connector on the OPPOSITE face
// When placing from a source connector facing 'n', the new room needs a connector facing 's' (opposite)
const CANDIDATES_BY_OPPOSITE_FACE: Map<Direction, Array<{ template: RoomTemplate; connIdx: number }>> = new Map();
for (const dir of ['n','s','e','w'] as Direction[]) {
  const opp = OPPOSITE[dir];
  const list: Array<{ template: RoomTemplate; connIdx: number }> = [];
  for (const t of TEMPLATES) {
    if (t.weight === 0) continue; // skip dead-ends from random selection
    for (let ci = 0; ci < t.connectors.length; ci++) {
      if (t.connectors[ci].face === opp) {
        // Add weight copies for weighted selection via shuffle
        for (let w = 0; w < t.weight; w++) {
          list.push({ template: t, connIdx: ci });
        }
      }
    }
  }
  CANDIDATES_BY_OPPOSITE_FACE.set(dir, list);
}

// Dead-end fallback lookup by face
const DEAD_END: Record<Direction, RoomTemplate> = {
  n: TEMPLATES.find(t => t.id === 'dead_s')!,
  s: TEMPLATES.find(t => t.id === 'dead_n')!,
  e: TEMPLATES.find(t => t.id === 'dead_w')!,
  w: TEMPLATES.find(t => t.id === 'dead_e')!,
};

// ─────────────────────────────────────────────
//  Deterministic room type
// ─────────────────────────────────────────────

function computeRoomType(ax: number, ay: number): RoomType {
  const roll = hash32(ax * 73856093 ^ ay * 19349663) % 100;
  if (roll < 55) return 'empty';
  if (roll < 75) return 'monster';
  if (roll < 87) return 'treasure';
  if (roll < 95) return 'trap';
  return 'shrine';
}

// ─────────────────────────────────────────────
//  World State
// ─────────────────────────────────────────────

const GENERATION_RADIUS  = 2;
const GAP_FILL_THRESHOLD = 15;
const GAP_FILL_MAX_STEPS = 30;

const PLAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#FF8C42', '#A8E6CF',
];

const cellToRoom  = new Map<string, string>();     // "x,y" → roomId
const roomGraph   = new Map<string, PlacedRoom>(); // roomId → PlacedRoom
const players     = new Map<string, Player>();
const allExplored = new Set<string>();              // roomIds
const frontier    = new Set<string>();              // roomIds
let   tick        = 0;
let   colorIndex  = 0;
let   roomCounter = 0;

function cellKey(x: number, y: number): string { return `${x},${y}`; }

function nextRoomId(): string { return `r${roomCounter++}`; }

// ─────────────────────────────────────────────
//  Placement Algorithm
// ─────────────────────────────────────────────

function placeRoom(template: RoomTemplate, anchorX: number, anchorY: number, entryConnIdx: number): PlacedRoom | null {
  // Compute world cells and check for overlaps
  const worldCells = new Set<string>();
  for (const [cx, cy] of template.cells) {
    const wx = anchorX + cx;
    const wy = anchorY + cy;
    const ck = cellKey(wx, wy);
    if (cellToRoom.has(ck)) return null; // overlap
    worldCells.add(ck);
  }

  const roomId = nextRoomId();
  const connectors: WorldConnector[] = template.connectors.map(c => ({
    cellX: anchorX + c.cellOffset[0],
    cellY: anchorY + c.cellOffset[1],
    face: c.face,
    linkedRoomId: null,
  }));

  const room: PlacedRoom = {
    roomId,
    templateId: template.id,
    anchorX, anchorY,
    worldCells,
    connectors,
    type: computeRoomType(anchorX, anchorY),
  };

  // Register
  roomGraph.set(roomId, room);
  for (const ck of worldCells) {
    cellToRoom.set(ck, roomId);
  }

  return room;
}

function linkConnectors(connA: WorldConnector, roomAId: string, connB: WorldConnector, roomBId: string): void {
  connA.linkedRoomId = roomBId;
  connB.linkedRoomId = roomAId;
}

/**
 * Try to place a room at an unlinked connector.
 * Returns the placed room or null if placement failed (dead-end placed instead).
 */
function placeRoomAtConnector(sourceConn: WorldConnector, sourceRoomId: string): PlacedRoom | null {
  const [dx, dy] = DIR_OFFSETS[sourceConn.face];
  const targetX = sourceConn.cellX + dx;
  const targetY = sourceConn.cellY + dy;
  const targetKey = cellKey(targetX, targetY);

  // Already occupied? Try to find a matching back-connector
  if (cellToRoom.has(targetKey)) {
    const existingRoomId = cellToRoom.get(targetKey)!;
    if (existingRoomId === sourceRoomId) return null; // same room, skip
    const existingRoom = roomGraph.get(existingRoomId)!;
    const oppFace = OPPOSITE[sourceConn.face];
    const backConn = existingRoom.connectors.find(c =>
      c.cellX === targetX && c.cellY === targetY && c.face === oppFace && c.linkedRoomId === null
    );
    if (backConn) {
      linkConnectors(sourceConn, sourceRoomId, backConn, existingRoomId);
      return existingRoom;
    }
    // No matching connector — this becomes a wall (leave unlinked)
    return null;
  }

  // Deterministic seed from world position + face
  const seed = hash32(targetX * 83492791 ^ targetY * 73856093 ^ FACE_HASH[sourceConn.face] * 15485863);

  // Get candidates: templates with a connector whose face is OPPOSITE to source face
  const candidates = CANDIDATES_BY_OPPOSITE_FACE.get(sourceConn.face);
  if (!candidates || candidates.length === 0) {
    // Fallback: dead-end
    return placeDeadEnd(sourceConn, sourceRoomId, targetX, targetY);
  }

  const shuffled = seededShuffle(candidates, seed);

  for (const { template, connIdx } of shuffled) {
    const entryConn = template.connectors[connIdx];
    // Anchor: the entry connector's cell offset must land on targetX, targetY
    const anchorX = targetX - entryConn.cellOffset[0];
    const anchorY = targetY - entryConn.cellOffset[1];

    const placed = placeRoom(template, anchorX, anchorY, connIdx);
    if (placed) {
      // Link the entry connector back to source
      const placedEntryConn = placed.connectors[connIdx];
      linkConnectors(sourceConn, sourceRoomId, placedEntryConn, placed.roomId);
      return placed;
    }
  }

  // No fit — dead-end fallback
  return placeDeadEnd(sourceConn, sourceRoomId, targetX, targetY);
}

function placeDeadEnd(sourceConn: WorldConnector, sourceRoomId: string, tx: number, ty: number): PlacedRoom | null {
  const template = DEAD_END[sourceConn.face];
  const placed = placeRoom(template, tx, ty, 0);
  if (placed) {
    linkConnectors(sourceConn, sourceRoomId, placed.connectors[0], placed.roomId);
    return placed;
  }
  return null;
}

// ─────────────────────────────────────────────
//  Flood-Fill (Room Graph BFS)
// ─────────────────────────────────────────────

function floodGenerateRooms(startRoomId: string, radius: number): void {
  const queue: Array<{ roomId: string; dist: number }> = [{ roomId: startRoomId, dist: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const { roomId, dist } = queue.shift()!;
    if (seen.has(roomId)) continue;
    seen.add(roomId);

    const room = roomGraph.get(roomId);
    if (!room) continue;

    if (!allExplored.has(roomId)) frontier.add(roomId);

    if (dist < radius) {
      // Try to place rooms at all unlinked connectors
      for (const conn of room.connectors) {
        if (conn.linkedRoomId === null) {
          const newRoom = placeRoomAtConnector(conn, roomId);
          if (newRoom && !seen.has(newRoom.roomId)) {
            if (!allExplored.has(newRoom.roomId)) frontier.add(newRoom.roomId);
            queue.push({ roomId: newRoom.roomId, dist: dist + 1 });
          }
        } else {
          if (!seen.has(conn.linkedRoomId)) {
            queue.push({ roomId: conn.linkedRoomId, dist: dist + 1 });
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────
//  Gap-Filling (Greedy Best-First on Room Graph)
// ─────────────────────────────────────────────

function greedyFillRooms(startRoomId: string, targetX: number, targetY: number): void {
  type Node = { roomId: string; g: number };
  const open: Node[] = [{ roomId: startRoomId, g: 0 }];
  const seen = new Set<string>();

  let steps = 0;
  while (open.length > 0 && steps < GAP_FILL_MAX_STEPS) {
    // Sort by Manhattan distance of room anchor to target
    open.sort((a, b) => {
      const ra = roomGraph.get(a.roomId)!, rb = roomGraph.get(b.roomId)!;
      const da = Math.abs(ra.anchorX - targetX) + Math.abs(ra.anchorY - targetY);
      const db = Math.abs(rb.anchorX - targetX) + Math.abs(rb.anchorY - targetY);
      return da - db;
    });

    const { roomId, g } = open.shift()!;
    if (seen.has(roomId)) continue;
    seen.add(roomId);
    steps++;

    const room = roomGraph.get(roomId);
    if (!room) continue;

    if (!allExplored.has(roomId)) frontier.add(roomId);

    // Close enough to target?
    if (Math.abs(room.anchorX - targetX) <= 1 && Math.abs(room.anchorY - targetY) <= 1) break;

    for (const conn of room.connectors) {
      if (conn.linkedRoomId === null) {
        const newRoom = placeRoomAtConnector(conn, roomId);
        if (newRoom && !seen.has(newRoom.roomId)) {
          if (!allExplored.has(newRoom.roomId)) frontier.add(newRoom.roomId);
          open.push({ roomId: newRoom.roomId, g: g + 1 });
        }
      } else if (!seen.has(conn.linkedRoomId)) {
        open.push({ roomId: conn.linkedRoomId, g: g + 1 });
      }
    }
  }
}

function fillGapsBetweenPlayers(): void {
  const list = Array.from(players.values());
  if (list.length < 2) return;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const chebDist = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      if (chebDist > GAP_FILL_THRESHOLD) continue;

      greedyFillRooms(a.currentRoomId, b.x, b.y);
      greedyFillRooms(b.currentRoomId, a.x, a.y);
    }
  }
}

// ─────────────────────────────────────────────
//  Player Movement
// ─────────────────────────────────────────────

function visitRoom(playerId: string, roomId: string): void {
  allExplored.add(roomId);
  frontier.delete(roomId);

  const player = players.get(playerId)!;
  player.explored.add(roomId);
  player.currentRoomId = roomId;

  floodGenerateRooms(roomId, GENERATION_RADIUS);
  fillGapsBetweenPlayers();
}

function spawnPlayer(id: string): Player {
  // Place spawn room: always a hub_1x1 at a random position
  const angle = Math.random() * Math.PI * 2;
  const dist  = 8 + Math.floor(Math.random() * 6);
  const sx    = Math.round(Math.cos(angle) * dist);
  const sy    = Math.round(Math.sin(angle) * dist);

  // Find a free cell near (sx, sy)
  let spawnX = sx, spawnY = sy;
  for (let r = 0; r <= 10; r++) {
    let found = false;
    for (let dx = -r; dx <= r && !found; dx++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (!cellToRoom.has(cellKey(sx + dx, sy + dy))) {
          spawnX = sx + dx;
          spawnY = sy + dy;
          found = true;
        }
      }
    }
    if (found) break;
  }

  const hubTemplate = TEMPLATES.find(t => t.id === 'hub_1x1')!;
  const spawnRoom = placeRoom(hubTemplate, spawnX, spawnY, 0);
  if (!spawnRoom) {
    // Absolute fallback — shouldn't happen
    const fallback = placeRoom(TEMPLATES[0], spawnX, spawnY, 0)!;
    fallback.type = 'spawn';
    const player: Player = {
      id, x: spawnX, y: spawnY,
      color: PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length],
      name: `Player ${players.size + 1}`,
      currentRoomId: fallback.roomId,
      explored: new Set(),
    };
    players.set(id, player);
    visitRoom(id, fallback.roomId);
    return player;
  }

  spawnRoom.type = 'spawn';

  const player: Player = {
    id, x: spawnX, y: spawnY,
    color: PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length],
    name: `Player ${players.size + 1}`,
    currentRoomId: spawnRoom.roomId,
    explored: new Set(),
  };
  players.set(id, player);
  visitRoom(id, spawnRoom.roomId);
  return player;
}

function movePlayer(id: string, dir: Direction): boolean {
  const player = players.get(id);
  if (!player) return false;

  const [dx, dy] = DIR_OFFSETS[dir];
  const nextX = player.x + dx;
  const nextY = player.y + dy;
  const nextKey = cellKey(nextX, nextY);
  const currKey = cellKey(player.x, player.y);

  const currRoomId = cellToRoom.get(currKey);
  if (!currRoomId) return false;

  const nextRoomId = cellToRoom.get(nextKey);

  // Case 1: next cell is in the SAME room → free movement
  if (nextRoomId === currRoomId) {
    player.x = nextX;
    player.y = nextY;
    tick++;
    return true;
  }

  // Case 2: next cell is in a DIFFERENT room via connector
  if (nextRoomId) {
    // Check that there's a connector linking these rooms at this boundary
    const currRoom = roomGraph.get(currRoomId)!;
    const hasLink = currRoom.connectors.some(c =>
      c.cellX === player.x && c.cellY === player.y &&
      c.face === dir && c.linkedRoomId === nextRoomId
    );
    if (hasLink) {
      player.x = nextX;
      player.y = nextY;
      visitRoom(id, nextRoomId);
      tick++;
      return true;
    }
    return false; // wall between rooms
  }

  // Case 3: next cell is unoccupied — check if current cell has an unlinked connector facing this way
  // (The flood-fill should have generated ahead, but if not, try now)
  const currRoom = roomGraph.get(currRoomId)!;
  const unlinkedConn = currRoom.connectors.find(c =>
    c.cellX === player.x && c.cellY === player.y &&
    c.face === dir && c.linkedRoomId === null
  );
  if (unlinkedConn) {
    // Try to generate on-demand
    const newRoom = placeRoomAtConnector(unlinkedConn, currRoomId);
    if (newRoom && cellToRoom.get(nextKey) === newRoom.roomId) {
      player.x = nextX;
      player.y = nextY;
      visitRoom(id, newRoom.roomId);
      tick++;
      return true;
    }
  }

  return false; // wall
}

// ─────────────────────────────────────────────
//  Serialization
// ─────────────────────────────────────────────

function serialisePlayers(): SerialPlayer[] {
  return Array.from(players.values()).map(p => ({
    id: p.id, x: p.x, y: p.y, color: p.color, name: p.name,
  }));
}

interface SerialRoom {
  roomId: string;
  templateId: string;
  anchorX: number;
  anchorY: number;
  cells: [number, number][];
  connectors: Array<{ cellX: number; cellY: number; face: Direction; linkedRoomId: string | null }>;
  type: RoomType;
}

function serialiseRoom(room: PlacedRoom): SerialRoom {
  return {
    roomId: room.roomId,
    templateId: room.templateId,
    anchorX: room.anchorX,
    anchorY: room.anchorY,
    cells: Array.from(room.worldCells).map(k => {
      const [x, y] = k.split(',').map(Number);
      return [x, y] as [number, number];
    }),
    connectors: room.connectors.map(c => ({
      cellX: c.cellX, cellY: c.cellY, face: c.face, linkedRoomId: c.linkedRoomId,
    })),
    type: room.type,
  };
}

function buildFullState(playerId: string): object {
  const player = players.get(playerId);
  return {
    type: 'full_state',
    rooms: Array.from(roomGraph.values()).map(serialiseRoom),
    players: serialisePlayers(),
    myExploredRooms: player ? Array.from(player.explored) : [],
    allExploredRooms: Array.from(allExplored),
    frontierRooms: Array.from(frontier),
    playerId,
    tick,
  };
}

function broadcastAll(): void {
  for (const [playerId, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(buildFullState(playerId)));
    }
  }
}

// ─────────────────────────────────────────────
//  HTTP + WebSocket server
// ─────────────────────────────────────────────

const clients = new Map<string, WebSocket>();

const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('Could not read index.html');
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 10);
  clients.set(id, ws);

  spawnPlayer(id);
  broadcastAll();

  console.log(`+ Player ${id} joined  (${players.size} total)`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'move') {
        if (movePlayer(id, msg.dir as Direction)) broadcastAll();
      }
    } catch (err) {
      console.error('Bad message:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    players.delete(id);
    broadcastAll();
    console.log(`- Player ${id} left   (${players.size} total)`);
  });

  ws.on('error', console.error);
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🏰 Dungeon server running at http://localhost:${PORT}`);
  console.log('   Open multiple tabs to add more players!\n');
});
