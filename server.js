const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;

const WORLD = { width: 4800, height: 3000 };
const TICK_MS = 50;
const START_MASS = 24;
const MAX_FOOD = 180;
const MAX_BOTS = 22;
const PLAYER_TIMEOUT_MS = 15000;
const RESPAWN_DELAY_MS = 2400;
const ROOM_IDLE_MS = 120000;
const MAX_UPGRADE_LEVEL = 5;

const RARITIES = {
  common: { id: "common", label: "Common", weight: 58, ring: "#d9e4ee" },
  uncommon: { id: "uncommon", label: "Uncommon", weight: 25, ring: "#67e8a8" },
  rare: { id: "rare", label: "Rare", weight: 11, ring: "#67b6ff" },
  epic: { id: "epic", label: "Epic", weight: 5, ring: "#d28bff" },
  legendary: { id: "legendary", label: "Legendary", weight: 1, ring: "#ffcf66" }
};

const variantTemplates = [
  { key: "native", label: "Native", rarity: "common", useBase: true },
  { key: "reef", label: "Reef Bloom", rarity: "uncommon", color: "#ff7f6b", accent: "#ffd7c7" },
  { key: "tide", label: "Tideglass", rarity: "rare", color: "#54c8ff", accent: "#d9f5ff" },
  { key: "nova", label: "Nova", rarity: "epic", color: "#c96cff", accent: "#f5d8ff" },
  { key: "sunforged", label: "Sunforged", rarity: "legendary", color: "#ffb545", accent: "#fff0a8" }
];

const rawSpecies = [
  { id: "sprout", label: "Sprout Fry", unlockScore: 0, color: "#f6c555", accent: "#fff0b7", speed: 202, accel: 430, boostCost: 0.08 },
  { id: "dartfin", label: "Dartfin", unlockScore: 90, color: "#ff8a5b", accent: "#ffd6bb", speed: 220, accel: 465, boostCost: 0.095 },
  { id: "reefglider", label: "Reef Glider", unlockScore: 220, color: "#3ec7c2", accent: "#cbfffb", speed: 190, accel: 418, boostCost: 0.072 },
  { id: "puffer", label: "Puffer Bruiser", unlockScore: 420, color: "#6bb0ff", accent: "#e3f1ff", speed: 178, accel: 390, boostCost: 0.055 },
  { id: "abyssal", label: "Abyssal Hunter", unlockScore: 650, color: "#9f7cff", accent: "#f0e8ff", speed: 208, accel: 440, boostCost: 0.1 }
];

const SPECIES = rawSpecies.map((species) => ({
  ...species,
  variants: variantTemplates.map((variant) => ({
    id: `${species.id}-${variant.key}`,
    label: variant.useBase ? `${species.label} Native` : `${species.label} ${variant.label}`,
    rarity: variant.rarity,
    color: variant.useBase ? species.color : variant.color,
    accent: variant.useBase ? species.accent : variant.accent
  }))
}));

const speciesById = Object.fromEntries(SPECIES.map((entry) => [entry.id, entry]));
const rarityList = Object.values(RARITIES);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

const rooms = new Map();
const playerSessions = new Map();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function random(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalize(x, y) {
  const length = Math.hypot(x, y);
  return length ? { x: x / length, y: y / length } : { x: 0, y: 0 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function massToRadius(mass) {
  return 7 + Math.sqrt(mass) * 3.1;
}

function sanitizeName(value) {
  const name = String(value || "Shoal Scout").trim().slice(0, 18);
  return name || "Shoal Scout";
}

function sanitizeRoomId(value) {
  const roomId = String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  return roomId || "ocean";
}

function variantForSpecies(species, variantId) {
  return species.variants.find((variant) => variant.id === variantId) || species.variants[0];
}

function startingMassFor(player) {
  return START_MASS + player.upgradeLevel * 2;
}

function applyLoadout(player, speciesId, variantId, upgradeLevel) {
  const species = speciesById[speciesId] || speciesById.sprout;
  const variant = variantForSpecies(species, variantId);
  player.speciesId = species.id;
  player.variantId = variant.id;
  player.color = variant.color;
  player.accent = variant.accent;
  player.rarity = variant.rarity;
  player.upgradeLevel = clamp(Number(upgradeLevel) || 0, 0, MAX_UPGRADE_LEVEL);
}

function speciesForMass(mass) {
  if (mass > 180) return speciesById.abyssal;
  if (mass > 120) return speciesById.puffer;
  if (mass > 70) return speciesById.reefglider;
  if (mass > 42) return speciesById.dartfin;
  return speciesById.sprout;
}

function createFood(room) {
  const palette = ["#ffcf5c", "#6ae9d0", "#ff7a8a", "#84a9ff", "#ffd3ee", "#9cff71"];
  return {
    id: `f${room.nextFoodId++}`,
    x: random(60, WORLD.width - 60),
    y: random(60, WORLD.height - 60),
    radius: random(4, 7),
    value: random(3, 8),
    color: palette[Math.floor(Math.random() * palette.length)]
  };
}

function createBot(room) {
  const mass = random(18, 190);
  const species = speciesForMass(mass);
  const variant = species.variants[Math.floor(random(0, Math.min(3, species.variants.length)))];
  return {
    id: `b${room.nextBotId++}`,
    name: ["Nib", "Reef", "Glint", "Snap", "Ripple", "Drift"][Math.floor(Math.random() * 6)],
    kind: "bot",
    x: random(110, WORLD.width - 110),
    y: random(110, WORLD.height - 110),
    vx: 0,
    vy: 0,
    inputX: random(-1, 1),
    inputY: random(-1, 1),
    boosting: false,
    mass,
    radius: massToRadius(mass),
    score: Math.max(0, mass - START_MASS),
    speciesId: species.id,
    variantId: variant.id,
    color: variant.color,
    accent: variant.accent,
    rarity: variant.rarity,
    upgradeLevel: 0,
    wanderAt: 0
  };
}

function ensurePopulation(room) {
  while (room.foods.length < MAX_FOOD) room.foods.push(createFood(room));
  while (room.bots.length < MAX_BOTS) room.bots.push(createBot(room));
}

function createRoom(roomId) {
  const room = {
    id: roomId,
    players: new Map(),
    foods: [],
    bots: [],
    nextFoodId: 1,
    nextBotId: 1,
    updatedAt: Date.now()
  };

  rooms.set(roomId, room);
  ensurePopulation(room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || createRoom(roomId);
}

function createPlayer(token, roomId, name, loadout) {
  const player = {
    token,
    roomId,
    name: sanitizeName(name),
    x: random(220, WORLD.width - 220),
    y: random(220, WORLD.height - 220),
    vx: 0,
    vy: 0,
    inputX: 0,
    inputY: 0,
    boosting: false,
    mass: START_MASS,
    radius: massToRadius(START_MASS),
    score: 0,
    bestScore: 0,
    speciesId: "sprout",
    variantId: "sprout-native",
    color: speciesById.sprout.color,
    accent: speciesById.sprout.accent,
    rarity: "common",
    upgradeLevel: 0,
    alive: true,
    respawnAt: 0,
    defeatedBy: "",
    streak: 0,
    lastSeen: Date.now()
  };

  applyLoadout(player, loadout.speciesId, loadout.variantId, loadout.upgradeLevel);
  player.mass = startingMassFor(player);
  player.radius = massToRadius(player.mass);
  return player;
}

function movePlayerToRoom(player, nextRoomId) {
  const currentRoom = rooms.get(player.roomId);
  if (currentRoom) {
    currentRoom.players.delete(player.token);
  }
  player.roomId = nextRoomId;
  player.x = random(220, WORLD.width - 220);
  player.y = random(220, WORLD.height - 220);
  player.vx = 0;
  player.vy = 0;
  player.inputX = 0;
  player.inputY = 0;
  player.boosting = false;
}

function getMoveStats(entity) {
  const species = speciesById[entity.speciesId] || speciesById.sprout;
  const sizePenalty = clamp((entity.mass - START_MASS) * 0.18, 0, 125);
  return {
    maxSpeed: Math.max(78, species.speed + entity.upgradeLevel * 4 - sizePenalty),
    accel: species.accel + entity.upgradeLevel * 10,
    boostCost: Math.max(0.03, species.boostCost - entity.upgradeLevel * 0.004)
  };
}

function applyMovement(entity, dt) {
  const desired = normalize(entity.inputX, entity.inputY);
  const stats = getMoveStats(entity);

  entity.vx += desired.x * stats.accel * dt;
  entity.vy += desired.y * stats.accel * dt;

  if (entity.boosting && entity.mass > startingMassFor(entity) + 5) {
    entity.vx += desired.x * stats.accel * 0.8 * dt;
    entity.vy += desired.y * stats.accel * 0.8 * dt;
    entity.mass = Math.max(startingMassFor(entity), entity.mass - stats.boostCost);
    entity.score = Math.max(0, entity.mass - startingMassFor(entity));
    entity.radius = massToRadius(entity.mass);
  }

  const drag = Math.pow(0.91, dt * 60);
  entity.vx *= drag;
  entity.vy *= drag;

  const speed = Math.hypot(entity.vx, entity.vy);
  const cap = stats.maxSpeed * (entity.boosting ? 1.16 : 1);
  if (speed > cap) {
    entity.vx = (entity.vx / speed) * cap;
    entity.vy = (entity.vy / speed) * cap;
  }

  entity.x = clamp(entity.x + entity.vx * dt, entity.radius, WORLD.width - entity.radius);
  entity.y = clamp(entity.y + entity.vy * dt, entity.radius, WORLD.height - entity.radius);
}

function grow(entity, amount) {
  entity.mass += amount;
  entity.score = Math.max(entity.score, entity.mass - startingMassFor(entity));
  entity.radius = massToRadius(entity.mass);
  entity.bestScore = Math.max(entity.bestScore, Math.floor(entity.score));
}

function respawnPlayer(player) {
  player.x = random(220, WORLD.width - 220);
  player.y = random(220, WORLD.height - 220);
  player.vx = 0;
  player.vy = 0;
  player.inputX = 0;
  player.inputY = 0;
  player.boosting = false;
  player.mass = startingMassFor(player);
  player.radius = massToRadius(player.mass);
  player.score = 0;
  player.alive = true;
  player.respawnAt = 0;
  player.defeatedBy = "";
  player.streak = 0;
}

function defeatPlayer(player, byName) {
  player.alive = false;
  player.respawnAt = Date.now() + RESPAWN_DELAY_MS;
  player.defeatedBy = byName || "a larger fish";
}

function consumeFoods(actor, room, multiplier) {
  for (let index = room.foods.length - 1; index >= 0; index -= 1) {
    const food = room.foods[index];
    if (distance(actor, food) <= actor.radius + food.radius) {
      grow(actor, food.value * multiplier);
      room.foods.splice(index, 1);
    }
  }
}

function canEat(predator, prey) {
  return predator.mass > prey.mass * 1.12 && distance(predator, prey) < predator.radius * 0.9;
}

function updateBots(room, now, dt) {
  const livePlayers = [...room.players.values()].filter((player) => player.alive);

  for (const bot of room.bots) {
    if (now >= bot.wanderAt) {
      const threat = livePlayers.find((player) => distance(bot, player) < 260 && player.mass > bot.mass * 1.18);
      const prey = livePlayers.find((player) => distance(bot, player) < 340 && bot.mass > player.mass * 1.18);

      if (threat) {
        const vector = normalize(bot.x - threat.x, bot.y - threat.y);
        bot.inputX = vector.x;
        bot.inputY = vector.y;
        bot.wanderAt = now + random(420, 880);
      } else if (prey) {
        const vector = normalize(prey.x - bot.x, prey.y - bot.y);
        bot.inputX = vector.x;
        bot.inputY = vector.y;
        bot.wanderAt = now + random(360, 720);
      } else {
        const vector = normalize(random(-1, 1), random(-1, 1));
        bot.inputX = vector.x;
        bot.inputY = vector.y;
        bot.wanderAt = now + random(900, 1800);
      }
    }

    bot.boosting = Math.random() < 0.03;
    applyMovement(bot, dt);
    consumeFoods(bot, room, 0.75);
  }
}

function respawnBot(room, index) {
  room.bots[index] = createBot(room);
}

function resolveEncounters(room) {
  const livePlayers = [...room.players.values()].filter((player) => player.alive);

  for (let i = 0; i < livePlayers.length; i += 1) {
    for (let j = i + 1; j < livePlayers.length; j += 1) {
      const a = livePlayers[i];
      const b = livePlayers[j];
      if (canEat(a, b)) {
        grow(a, b.mass * 0.62);
        a.streak += 1;
        defeatPlayer(b, a.name);
      } else if (canEat(b, a)) {
        grow(b, a.mass * 0.62);
        b.streak += 1;
        defeatPlayer(a, b.name);
      }
    }
  }

  for (const player of livePlayers) {
    for (let index = room.bots.length - 1; index >= 0; index -= 1) {
      const bot = room.bots[index];
      if (canEat(player, bot)) {
        grow(player, bot.mass * 0.48);
        player.streak += 1;
        respawnBot(room, index);
      } else if (canEat(bot, player)) {
        grow(bot, player.mass * 0.5);
        defeatPlayer(player, bot.name);
      }
    }
  }
}

function pruneRoom(room, now) {
  for (const [token, player] of room.players) {
    if (now - player.lastSeen > PLAYER_TIMEOUT_MS) {
      room.players.delete(token);
      playerSessions.delete(token);
    }
  }

  if (!room.players.size && now - room.updatedAt > ROOM_IDLE_MS) {
    rooms.delete(room.id);
  }
}

function tickRooms() {
  const now = Date.now();
  const dt = TICK_MS / 1000;

  for (const room of rooms.values()) {
    room.updatedAt = now;

    for (const player of room.players.values()) {
      if (!player.alive) {
        if (now >= player.respawnAt) {
          respawnPlayer(player);
        }
        continue;
      }

      applyMovement(player, dt);
      consumeFoods(player, room, 1);
    }

    updateBots(room, now, dt);
    resolveEncounters(room);
    ensurePopulation(room);
    pruneRoom(room, now);
  }
}

function leaderboard(room) {
  return [...room.players.values()]
    .filter((player) => player.alive)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((player) => ({
      name: player.name,
      score: Math.floor(player.score),
      speciesId: player.speciesId,
      rarity: player.rarity
    }));
}

function serializeEntity(entity) {
  return {
    name: entity.name,
    x: entity.x,
    y: entity.y,
    vx: entity.vx,
    vy: entity.vy,
    radius: entity.radius,
    mass: entity.mass,
    speciesId: entity.speciesId,
    variantId: entity.variantId,
    color: entity.color,
    accent: entity.accent,
    rarity: entity.rarity,
    upgradeLevel: entity.upgradeLevel
  };
}

function snapshotFor(player) {
  const room = rooms.get(player.roomId);
  const nearbyRange = 1700;
  const isNearby = (entity) => distance(player, entity) < nearbyRange;

  return {
    now: Date.now(),
    roomId: room.id,
    world: WORLD,
    self: {
      token: player.token,
      ...serializeEntity(player),
      score: Math.floor(player.score),
      bestScore: Math.floor(player.bestScore),
      alive: player.alive,
      respawnAt: player.respawnAt,
      defeatedBy: player.defeatedBy,
      streak: player.streak
    },
    players: [...room.players.values()]
      .filter((entry) => entry.token !== player.token && entry.alive && isNearby(entry))
      .map((entry) => ({
        token: entry.token,
        ...serializeEntity(entry),
        score: Math.floor(entry.score)
      })),
    bots: room.bots
      .filter((entry) => isNearby(entry))
      .map((entry) => ({
        id: entry.id,
        ...serializeEntity(entry)
      })),
    foods: room.foods
      .filter((entry) => isNearby(entry))
      .map((entry) => ({
        id: entry.id,
        x: entry.x,
        y: entry.y,
        radius: entry.radius,
        color: entry.color
      })),
    leaderboard: leaderboard(room),
    roomPopulation: room.players.size
  };
}

function serveStatic(reqPath, res) {
  const safePath = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT_DIR, safePath);
  if (!filePath.startsWith(ROOT_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      world: WORLD,
      species: SPECIES,
      rarities: rarityList,
      maxUpgradeLevel: MAX_UPGRADE_LEVEL
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/join") {
    try {
      const body = await readBody(req);
      const roomId = sanitizeRoomId(body.roomId);
      const name = sanitizeName(body.name);
      const loadout = {
        speciesId: body.speciesId,
        variantId: body.variantId,
        upgradeLevel: body.upgradeLevel
      };

      let token = typeof body.token === "string" ? body.token : "";
      let player = token ? playerSessions.get(token) : null;

      if (!player) {
        token = crypto.randomUUID();
        player = createPlayer(token, roomId, name, loadout);
        playerSessions.set(token, player);
      }

      if (player.roomId !== roomId) {
        movePlayerToRoom(player, roomId);
      }

      player.name = name;
      applyLoadout(player, loadout.speciesId, loadout.variantId, loadout.upgradeLevel);
      player.lastSeen = Date.now();
      getRoom(roomId).players.set(token, player);

      const shareUrl = `${url.protocol}//${url.host}/?room=${roomId}`;
      sendJson(res, 200, {
        token,
        roomId,
        shareUrl,
        species: SPECIES,
        rarities: rarityList,
        maxUpgradeLevel: MAX_UPGRADE_LEVEL
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/input") {
    try {
      const body = await readBody(req);
      const player = playerSessions.get(body.token);
      if (!player) {
        sendJson(res, 404, { error: "Player not found" });
        return;
      }

      player.inputX = clamp(Number(body.x) || 0, -1, 1);
      player.inputY = clamp(Number(body.y) || 0, -1, 1);
      player.boosting = Boolean(body.boost);
      player.lastSeen = Date.now();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/loadout") {
    try {
      const body = await readBody(req);
      const player = playerSessions.get(body.token);
      if (!player) {
        sendJson(res, 404, { error: "Player not found" });
        return;
      }

      applyLoadout(player, body.speciesId, body.variantId, body.upgradeLevel);
      player.lastSeen = Date.now();
      sendJson(res, 200, {
        ok: true,
        speciesId: player.speciesId,
        variantId: player.variantId,
        upgradeLevel: player.upgradeLevel
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const token = url.searchParams.get("token");
    const player = token ? playerSessions.get(token) : null;
    if (!player) {
      sendJson(res, 404, { error: "Session expired" });
      return;
    }

    player.lastSeen = Date.now();
    sendJson(res, 200, snapshotFor(player));
    return;
  }

  if (req.method === "GET") {
    serveStatic(url.pathname, res);
    return;
  }

  sendText(res, 405, "Method not allowed");
}

setInterval(tickRooms, TICK_MS);

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: error.message });
  });
});

server.listen(PORT, () => {
  console.log(`Grow multiplayer listening on http://localhost:${PORT}`);
});
