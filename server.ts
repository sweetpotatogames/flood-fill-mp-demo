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
const ALL_DIRS: Direction[] = ['n', 's', 'e', 'w'];

interface Room {
  x:     number;
  y:     number;
  exits: Direction[];
  type:  RoomType;
}

interface Player {
  id:       string;
  x:        number;
  y:        number;
  color:    string;
  name:     string;
  explored: Set<string>;  // rooms this player has personally walked into
}

interface SerialPlayer {
  id:    string;
  x:     number;
  y:     number;
  color: string;
  name:  string;
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

function roomSeed(x: number, y: number): number {
  return hash32(hash32(x * 73856093) ^ hash32(y * 19349663));
}

function hasPassage(ax: number, ay: number, bx: number, by: number): boolean {
  let x1 = ax, y1 = ay, x2 = bx, y2 = by;
  if (ax > bx || (ax === bx && ay > by)) { x1 = bx; y1 = by; x2 = ax; y2 = ay; }
  const h = hash32(x1 * 83492791 ^ y1 * 73856093 ^ x2 * 15485863 ^ y2 * 19349663);
  return (h % 100) < 65;
}

/**
 * Deterministic room type from coordinates.
 * Distribution: 55% empty, 20% monster, 12% treasure, 8% trap, 5% shrine
 */
function computeRoomType(x: number, y: number): RoomType {
  const roll = roomSeed(x, y) % 100;
  if (roll < 55) return 'empty';
  if (roll < 75) return 'monster';
  if (roll < 87) return 'treasure';
  if (roll < 95) return 'trap';
  return 'shrine';
}

function computeExits(x: number, y: number): Direction[] {
  const exits: Direction[] = [];
  for (const dir of ALL_DIRS) {
    const [dx, dy] = DIR_OFFSETS[dir];
    if (hasPassage(x, y, x + dx, y + dy)) exits.push(dir);
  }
  if (exits.length === 0) exits.push(ALL_DIRS[roomSeed(x, y) % 4]);
  return exits;
}

// ─────────────────────────────────────────────
//  Dungeon state
// ─────────────────────────────────────────────

const GENERATION_RADIUS  = 2;   // flood-fill hops ahead of each player
const GAP_FILL_THRESHOLD = 12;  // max Chebyshev distance to trigger gap-filling
const GAP_FILL_RADIUS    = 5;   // extra hops generated toward other players

const PLAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#FF8C42', '#A8E6CF',
];

const rooms       = new Map<string, Room>();
const players     = new Map<string, Player>();
const allExplored = new Set<string>();  // union of all player explored sets
const frontier    = new Set<string>();  // generated, not yet visited by anyone
let   tick        = 0;
let   colorIndex  = 0;

function key(x: number, y: number): string { return `${x},${y}`; }

function ensureRoom(x: number, y: number): Room {
  const k = key(x, y);
  if (rooms.has(k)) return rooms.get(k)!;
  const room: Room = { x, y, exits: computeExits(x, y), type: computeRoomType(x, y) };
  rooms.set(k, room);
  return room;
}

/**
 * Flood-fill BFS from (cx, cy) up to `radius` hops through valid passages.
 * Generates any missing rooms and adds them to the frontier.
 */
function floodGenerate(cx: number, cy: number, radius: number): void {
  const queue: Array<{ x: number; y: number; dist: number }> = [{ x: cx, y: cy, dist: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const { x, y, dist } = queue.shift()!;
    const k = key(x, y);
    if (seen.has(k)) continue;
    seen.add(k);

    const room = ensureRoom(x, y);
    if (!allExplored.has(k)) frontier.add(k);

    if (dist < radius) {
      for (const dir of room.exits) {
        const [dx, dy] = DIR_OFFSETS[dir];
        queue.push({ x: x + dx, y: y + dy, dist: dist + 1 });
      }
    }
  }
}

/**
 * Greedy best-first fill from A toward B.
 * Punches through the passage graph connecting two players,
 * generating every room it touches.  Capped at a sensible depth
 * to avoid runaway generation when players are far apart.
 */
function greedyFill(sx: number, sy: number, tx: number, ty: number): void {
  type Node = { x: number; y: number; g: number };
  const open: Node[] = [{ x: sx, y: sy, g: 0 }];
  const seen = new Set<string>();
  const maxG = Math.max(Math.abs(tx - sx), Math.abs(ty - sy)) + GAP_FILL_RADIUS;

  while (open.length > 0) {
    // Sort by h (Manhattan distance to target) — greedy best-first
    open.sort((a, b) =>
      (Math.abs(a.x - tx) + Math.abs(a.y - ty)) -
      (Math.abs(b.x - tx) + Math.abs(b.y - ty))
    );
    const { x, y, g } = open.shift()!;
    const k = key(x, y);
    if (seen.has(k)) continue;
    seen.add(k);

    const room = ensureRoom(x, y);
    if (!allExplored.has(k)) frontier.add(k);
    if (x === tx && y === ty) break;
    if (g >= maxG) continue;

    for (const dir of room.exits) {
      const [dx, dy] = DIR_OFFSETS[dir];
      open.push({ x: x + dx, y: y + dy, g: g + 1 });
    }
  }
}

/**
 * For every pair of nearby players, run floodGenerate from both ends
 * plus a greedy fill between them so the corridor connecting them
 * is always pre-generated.
 */
function fillGapsBetweenPlayers(): void {
  const list = Array.from(players.values());
  if (list.length < 2) return;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const chebDist = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      if (chebDist > GAP_FILL_THRESHOLD) continue;

      floodGenerate(a.x, a.y, GAP_FILL_RADIUS);
      floodGenerate(b.x, b.y, GAP_FILL_RADIUS);
      greedyFill(a.x, a.y, b.x, b.y);
    }
  }
}

/** Called when a player physically enters a room. */
function visitRoom(playerId: string, x: number, y: number): void {
  const k = key(x, y);
  allExplored.add(k);
  frontier.delete(k);

  const player = players.get(playerId)!;
  player.explored.add(k);

  floodGenerate(x, y, GENERATION_RADIUS);
  fillGapsBetweenPlayers();
}

function spawnPlayer(id: string): Player {
  const angle = Math.random() * Math.PI * 2;
  const dist  = 8 + Math.floor(Math.random() * 6);
  const sx    = Math.round(Math.cos(angle) * dist);
  const sy    = Math.round(Math.sin(angle) * dist);

  const player: Player = {
    id,
    x: sx, y: sy,
    color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
    name:  `Player ${players.size + 1}`,
    explored: new Set(),
  };
  colorIndex++;
  players.set(id, player);

  visitRoom(id, sx, sy);

  // Mark spawn room type
  const spawnRoom = rooms.get(key(sx, sy))!;
  spawnRoom.type = 'spawn';

  return player;
}

function movePlayer(id: string, dir: Direction): boolean {
  const player = players.get(id);
  if (!player) return false;

  const room = rooms.get(key(player.x, player.y));
  if (!room || !room.exits.includes(dir)) return false;

  const [dx, dy] = DIR_OFFSETS[dir];
  player.x += dx;
  player.y += dy;

  visitRoom(id, player.x, player.y);
  tick++;
  return true;
}

// ─────────────────────────────────────────────
//  Serialisation helpers
// ─────────────────────────────────────────────

function serialisePlayers(): SerialPlayer[] {
  return Array.from(players.values()).map(p => ({
    id: p.id, x: p.x, y: p.y, color: p.color, name: p.name,
  }));
}

/** Full snapshot for new connections or reconnects. */
function buildFullState(playerId: string): object {
  const player = players.get(playerId);
  return {
    type:       'full_state',
    rooms:       Array.from(rooms.values()),
    players:     serialisePlayers(),
    myExplored:  player ? Array.from(player.explored) : [],
    allExplored: Array.from(allExplored),
    frontier:    Array.from(frontier),
    playerId,
    tick,
  };
}

/** Broadcast full state to every client (used after any mutation). */
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
