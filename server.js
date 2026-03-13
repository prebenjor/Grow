const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

const WORLD = { width: 4800, height: 3000 };
const TICK_MS = 50;
const SNAPSHOT_MS = 100;
const START_MASS = 24;
const MAX_FOOD = 180;
const MAX_BOTS = 22;
const PLAYER_TIMEOUT_MS = 15000;
const RESPAWN_DELAY_MS = 2400;
const ROOM_IDLE_MS = 120000;
const MAX_UPGRADE_LEVEL = 5;
const HEARTBEAT_MS = 15000;
const SAVE_DEBOUNCE_MS = 250;

const RATE_LIMITS = {
  http: { windowMs: 10000, max: 180 },
  websocket: { windowMs: 10000, max: 240 },
  upgrade: { windowMs: 10000, max: 24 }
};

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

const baseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin"
};

const rooms = new Map();
const playerSessions = new Map();
const profiles = loadProfiles();
const rateBuckets = new Map();

let saveTimer = null;
let tickTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;

function log(level, message, meta = {}) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...meta
    })
  );
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadProfiles() {
  try {
    ensureDataDir();
    if (!fs.existsSync(PROFILES_FILE)) {
      return new Map();
    }

    const parsed = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
    return new Map(
      Object.entries(parsed).map(([token, profile]) => [token, normalizeProfile(profile)])
    );
  } catch (error) {
    log("error", "Failed to load profiles from disk", { error: error.message });
    return new Map();
  }
}

function flushProfilesSync() {
  try {
    ensureDataDir();
    const payload = Object.fromEntries(
      [...profiles.entries()].map(([token, profile]) => [token, publicProfile(profile)])
    );
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(payload, null, 2));
  } catch (error) {
    log("error", "Failed to flush profiles", { error: error.message });
  }
}

function scheduleProfilesSave() {
  if (saveTimer) {
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushProfilesSync();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...baseHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    ...baseHeaders,
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
      } catch {
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

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function consumeRateLimit(key, limit) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }

  if (bucket.count >= limit.max) {
    return false;
  }

  bucket.count += 1;
  return true;
}

function enforceHttpRateLimit(req, res) {
  const key = `http:${clientIp(req)}`;
  if (consumeRateLimit(key, RATE_LIMITS.http)) {
    return true;
  }

  sendJson(res, 429, { error: "Too many requests" });
  return false;
}

function createDefaultProfile(name) {
  return normalizeProfile({
    name: sanitizeName(name),
    bestScore: 0,
    pearls: 0,
    unlockedSpecies: ["sprout"],
    selectedSpecies: "sprout",
    ownedVariants: {},
    selectedVariants: {},
    upgrades: {}
  });
}

function publicProfile(profile) {
  const ownedVariants = {};
  const selectedVariants = {};
  const upgrades = {};

  for (const species of SPECIES) {
    ownedVariants[species.id] = [...profile.ownedVariants[species.id]];
    selectedVariants[species.id] = profile.selectedVariants[species.id];
    upgrades[species.id] = profile.upgrades[species.id];
  }

  return {
    name: profile.name,
    bestScore: profile.bestScore,
    pearls: profile.pearls,
    unlockedSpecies: [...profile.unlockedSpecies],
    selectedSpecies: profile.selectedSpecies,
    ownedVariants,
    selectedVariants,
    upgrades,
    updatedAt: profile.updatedAt
  };
}

function normalizeProfile(rawProfile) {
  const profile = {
    name: sanitizeName(rawProfile?.name),
    bestScore: Math.max(0, Math.floor(Number(rawProfile?.bestScore) || 0)),
    pearls: Math.max(0, Math.floor(Number(rawProfile?.pearls) || 0)),
    unlockedSpecies: Array.isArray(rawProfile?.unlockedSpecies) ? [...rawProfile.unlockedSpecies] : [],
    selectedSpecies: typeof rawProfile?.selectedSpecies === "string" ? rawProfile.selectedSpecies : "sprout",
    ownedVariants: rawProfile?.ownedVariants && typeof rawProfile.ownedVariants === "object" ? { ...rawProfile.ownedVariants } : {},
    selectedVariants:
      rawProfile?.selectedVariants && typeof rawProfile.selectedVariants === "object" ? { ...rawProfile.selectedVariants } : {},
    upgrades: rawProfile?.upgrades && typeof rawProfile.upgrades === "object" ? { ...rawProfile.upgrades } : {},
    updatedAt: Date.now()
  };

  const unlocked = new Set(profile.unlockedSpecies.filter((speciesId) => speciesById[speciesId]));
  unlocked.add("sprout");

  for (const species of SPECIES) {
    if (profile.bestScore >= species.unlockScore) {
      unlocked.add(species.id);
    }

    const owned = new Set(
      Array.isArray(profile.ownedVariants[species.id])
        ? profile.ownedVariants[species.id].filter((variantId) => species.variants.some((variant) => variant.id === variantId))
        : []
    );
    owned.add(species.variants[0].id);
    profile.ownedVariants[species.id] = [...owned];

    const selectedVariant = profile.selectedVariants[species.id];
    profile.selectedVariants[species.id] = owned.has(selectedVariant) ? selectedVariant : species.variants[0].id;
    profile.upgrades[species.id] = clamp(Number(profile.upgrades[species.id]) || 0, 0, MAX_UPGRADE_LEVEL);
  }

  profile.unlockedSpecies = [...unlocked];
  if (!unlocked.has(profile.selectedSpecies)) {
    profile.selectedSpecies = "sprout";
  }

  return profile;
}

function normalizeProfileInPlace(profile) {
  const normalized = normalizeProfile(profile);
  profile.name = normalized.name;
  profile.bestScore = normalized.bestScore;
  profile.pearls = normalized.pearls;
  profile.unlockedSpecies = normalized.unlockedSpecies;
  profile.selectedSpecies = normalized.selectedSpecies;
  profile.ownedVariants = normalized.ownedVariants;
  profile.selectedVariants = normalized.selectedVariants;
  profile.upgrades = normalized.upgrades;
  profile.updatedAt = Date.now();
}

function getOrCreateProfile(token, name) {
  let profile = profiles.get(token);
  if (!profile) {
    profile = createDefaultProfile(name);
    profiles.set(token, profile);
    scheduleProfilesSave();
  }

  const sanitizedName = sanitizeName(name);
  if (profile.name !== sanitizedName) {
    profile.name = sanitizedName;
    profile.updatedAt = Date.now();
    scheduleProfilesSave();
  }

  return profile;
}

function variantForSpecies(species, variantId) {
  return species.variants.find((variant) => variant.id === variantId) || species.variants[0];
}

function ownedVariantIds(profile, speciesId) {
  const species = speciesById[speciesId] || speciesById.sprout;
  const owned = profile.ownedVariants[species.id];
  return Array.isArray(owned) && owned.length ? owned : [species.variants[0].id];
}

function selectedVariantId(profile, speciesId) {
  const species = speciesById[speciesId] || speciesById.sprout;
  const owned = new Set(ownedVariantIds(profile, species.id));
  const selected = profile.selectedVariants[species.id];
  return owned.has(selected) ? selected : species.variants[0].id;
}

function upgradeLevelForProfile(profile, speciesId) {
  return clamp(Number(profile.upgrades[speciesId]) || 0, 0, MAX_UPGRADE_LEVEL);
}

function startingMassFor(player) {
  return START_MASS + player.upgradeLevel * 2;
}

function variantDiscoveryCost(species) {
  return 12 + Math.floor(species.unlockScore / 18);
}

function upgradeCost(species, currentLevel) {
  return 18 + currentLevel * 26 + Math.floor(species.unlockScore / 12);
}

function applySelectedVariant(profile, speciesId, variantId, variantOnly = false) {
  const species = speciesById[speciesId] || speciesById.sprout;
  const owned = new Set(ownedVariantIds(profile, species.id));
  const nextVariantId = owned.has(variantId) ? variantId : species.variants[0].id;
  if (!variantOnly) {
    profile.selectedSpecies = species.id;
  }
  profile.selectedVariants[species.id] = nextVariantId;
}

function applyProfileLoadout(player, requestedSpeciesId, requestedVariantId) {
  const profile = player.profile;
  const desiredSpeciesId = profile.unlockedSpecies.includes(requestedSpeciesId) ? requestedSpeciesId : profile.selectedSpecies;
  const species = speciesById[desiredSpeciesId] || speciesById.sprout;
  const owned = new Set(ownedVariantIds(profile, species.id));
  const variantId = owned.has(requestedVariantId) ? requestedVariantId : selectedVariantId(profile, species.id);
  const variant = variantForSpecies(species, variantId);

  player.speciesId = species.id;
  player.variantId = variant.id;
  player.color = variant.color;
  player.accent = variant.accent;
  player.rarity = variant.rarity;
  player.upgradeLevel = upgradeLevelForProfile(profile, species.id);

  const minimumMass = startingMassFor(player);
  if (!player.mass || player.mass < minimumMass) {
    player.mass = minimumMass;
  }
  player.radius = massToRadius(player.mass);
  player.score = Math.max(0, player.mass - minimumMass);
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

function createPlayer(token, roomId, name, profile, loadout) {
  const player = {
    token,
    roomId,
    name: sanitizeName(name),
    profile,
    socket: null,
    ip: "",
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
    lastSeen: Date.now(),
    lastSnapshotAt: 0,
    runPearlsGranted: 0
  };

  applyProfileLoadout(player, loadout.speciesId, loadout.variantId);
  player.mass = startingMassFor(player);
  player.radius = massToRadius(player.mass);
  player.score = 0;
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
  player.lastSnapshotAt = 0;
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
  player.runPearlsGranted = 0;
}

function defeatPlayer(player, byName) {
  player.alive = false;
  player.respawnAt = Date.now() + RESPAWN_DELAY_MS;
  player.defeatedBy = byName || "a larger fish";
  player.runPearlsGranted = 0;
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
        emit(b.socket, { type: "event", eventType: "defeat", message: `Eaten by ${a.name}` });
      } else if (canEat(b, a)) {
        grow(b, a.mass * 0.62);
        b.streak += 1;
        defeatPlayer(a, b.name);
        emit(a.socket, { type: "event", eventType: "defeat", message: `Eaten by ${b.name}` });
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
        emit(player.socket, { type: "event", eventType: "defeat", message: `Eaten by ${bot.name}` });
      }
    }
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
      bestScore: Math.max(player.profile.bestScore, Math.floor(player.bestScore)),
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

function emit(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function emitProfile(player) {
  emit(player.socket, {
    type: "profile",
    profile: publicProfile(player.profile)
  });
}

function emitSnapshot(player) {
  emit(player.socket, {
    type: "snapshot",
    snapshot: snapshotFor(player)
  });
}

function updateProfileProgress(player) {
  const profile = player.profile;
  let changed = false;
  const unlockedBefore = new Set(profile.unlockedSpecies);
  const runPearls = Math.floor(Math.max(0, player.score) / 12);

  if (runPearls > player.runPearlsGranted) {
    profile.pearls += runPearls - player.runPearlsGranted;
    player.runPearlsGranted = runPearls;
    changed = true;
  }

  const bestScore = Math.max(profile.bestScore, Math.floor(player.bestScore), Math.floor(player.score));
  if (bestScore !== profile.bestScore) {
    profile.bestScore = bestScore;
    changed = true;
  }

  for (const species of SPECIES) {
    if (profile.bestScore >= species.unlockScore && !profile.unlockedSpecies.includes(species.id)) {
      profile.unlockedSpecies.push(species.id);
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  normalizeProfileInPlace(profile);
  scheduleProfilesSave();
  emitProfile(player);

  for (const speciesId of profile.unlockedSpecies) {
    if (!unlockedBefore.has(speciesId)) {
      emit(player.socket, {
        type: "event",
        eventType: "unlock",
        message: `Unlocked ${speciesById[speciesId].label}`
      });
    }
  }
}

function pruneRoom(room, now) {
  for (const [token, player] of room.players) {
    const connected = player.socket && player.socket.readyState === WebSocket.OPEN;
    if (!connected && now - player.lastSeen > PLAYER_TIMEOUT_MS) {
      room.players.delete(token);
      playerSessions.delete(token);
    }
  }

  if (!room.players.size && now - room.updatedAt > ROOM_IDLE_MS) {
    rooms.delete(room.id);
  }
}

function broadcastRoom(room, now) {
  for (const player of room.players.values()) {
    if (!player.socket || player.socket.readyState !== WebSocket.OPEN) {
      continue;
    }
    if (now - player.lastSnapshotAt < SNAPSHOT_MS) {
      continue;
    }

    player.lastSeen = now;
    player.lastSnapshotAt = now;
    emitSnapshot(player);
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

    for (const player of room.players.values()) {
      updateProfileProgress(player);
    }

    ensurePopulation(room);
    pruneRoom(room, now);
    broadcastRoom(room, now);
  }
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
      ...baseHeaders,
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Content-Length": data.length
    });
    res.end(data);
  });
}

function mergeMigratedProfile(profile, incoming) {
  const merged = publicProfile(profile);
  merged.name = sanitizeName(incoming?.name || profile.name);
  merged.bestScore = Math.max(profile.bestScore, Math.floor(Number(incoming?.bestScore) || 0));
  merged.pearls = Math.max(profile.pearls, Math.floor(Number(incoming?.pearls) || 0));
  merged.unlockedSpecies = [...new Set([...profile.unlockedSpecies, ...(Array.isArray(incoming?.unlockedSpecies) ? incoming.unlockedSpecies : [])])];

  for (const species of SPECIES) {
    const incomingOwned = Array.isArray(incoming?.ownedVariants?.[species.id]) ? incoming.ownedVariants[species.id] : [];
    merged.ownedVariants[species.id] = [...new Set([...profile.ownedVariants[species.id], ...incomingOwned])];
    merged.upgrades[species.id] = Math.max(profile.upgrades[species.id], clamp(Number(incoming?.upgrades?.[species.id]) || 0, 0, MAX_UPGRADE_LEVEL));

    const candidateVariant = incoming?.selectedVariants?.[species.id];
    merged.selectedVariants[species.id] = candidateVariant || profile.selectedVariants[species.id];
  }

  if (merged.unlockedSpecies.includes(incoming?.selectedSpecies)) {
    merged.selectedSpecies = incoming.selectedSpecies;
  }

  const normalized = normalizeProfile(merged);
  profile.name = normalized.name;
  profile.bestScore = normalized.bestScore;
  profile.pearls = normalized.pearls;
  profile.unlockedSpecies = normalized.unlockedSpecies;
  profile.selectedSpecies = normalized.selectedSpecies;
  profile.ownedVariants = normalized.ownedVariants;
  profile.selectedVariants = normalized.selectedVariants;
  profile.upgrades = normalized.upgrades;
  profile.updatedAt = Date.now();
}

function rollLockedVariant(profile, species) {
  const owned = new Set(ownedVariantIds(profile, species.id));
  const lockedVariants = species.variants.filter((variant) => !owned.has(variant.id));
  if (!lockedVariants.length) {
    return null;
  }

  const totalWeight = lockedVariants.reduce((sum, variant) => sum + RARITIES[variant.rarity].weight, 0);
  let roll = Math.random() * totalWeight;

  for (const variant of lockedVariants) {
    roll -= RARITIES[variant.rarity].weight;
    if (roll <= 0) {
      return variant;
    }
  }

  return lockedVariants[lockedVariants.length - 1];
}

function performProfileAction(token, body) {
  const profile = profiles.get(token);
  if (!profile) {
    throw new Error("Profile not found");
  }

  const player = playerSessions.get(token);
  const action = String(body.action || "");
  const species = speciesById[body.speciesId];

  if (body.clientId && !consumeRateLimit(`profile:${token}:${body.clientId}`, RATE_LIMITS.upgrade)) {
    throw new Error("Too many profile actions");
  }

  let message = "";
  let discoveredVariant = null;

  if (action === "selectSpecies") {
    if (!species || !profile.unlockedSpecies.includes(species.id)) {
      throw new Error("Species not unlocked");
    }

    profile.selectedSpecies = species.id;
    applySelectedVariant(profile, species.id, body.variantId);
    message = `${species.label} selected`;
  } else if (action === "selectVariant") {
    if (!species) {
      throw new Error("Species not found");
    }

    applySelectedVariant(profile, species.id, body.variantId, true);
    message = `${variantForSpecies(species, profile.selectedVariants[species.id]).label} selected`;
  } else if (action === "upgradeSpecies") {
    if (!species || !profile.unlockedSpecies.includes(species.id)) {
      throw new Error("Species not unlocked");
    }

    const currentLevel = upgradeLevelForProfile(profile, species.id);
    const cost = upgradeCost(species, currentLevel);
    if (currentLevel >= MAX_UPGRADE_LEVEL) {
      throw new Error("Already at max level");
    }
    if (profile.pearls < cost) {
      throw new Error("Not enough pearls");
    }

    profile.pearls -= cost;
    profile.upgrades[species.id] = currentLevel + 1;
    message = `${species.label} upgraded to Lv.${currentLevel + 1}`;
  } else if (action === "scoutVariant") {
    if (!species || !profile.unlockedSpecies.includes(species.id)) {
      throw new Error("Species not unlocked");
    }

    const cost = variantDiscoveryCost(species);
    if (profile.pearls < cost) {
      throw new Error("Not enough pearls");
    }

    discoveredVariant = rollLockedVariant(profile, species);
    if (!discoveredVariant) {
      throw new Error("All variants already collected");
    }

    profile.pearls -= cost;
    profile.ownedVariants[species.id] = [...new Set([...profile.ownedVariants[species.id], discoveredVariant.id])];
    profile.selectedVariants[species.id] = discoveredVariant.id;
    message = `Found ${discoveredVariant.label} (${RARITIES[discoveredVariant.rarity].label})`;
  } else {
    throw new Error("Unsupported profile action");
  }

  normalizeProfileInPlace(profile);
  scheduleProfilesSave();

  if (player) {
    player.profile = profile;
    player.name = profile.name;
    applyProfileLoadout(player, profile.selectedSpecies, profile.selectedVariants[profile.selectedSpecies]);
    if (!player.alive) {
      player.mass = startingMassFor(player);
      player.radius = massToRadius(player.mass);
    }
    emitProfile(player);
    emitSnapshot(player);
  }

  return {
    profile: publicProfile(profile),
    message,
    discoveredVariant
  };
}

async function handleRequest(req, res) {
  if (!enforceHttpRateLimit(req, res)) {
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      rooms: rooms.size,
      livePlayers: playerSessions.size,
      profiles: profiles.size,
      shuttingDown
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      world: WORLD,
      species: SPECIES,
      rarities: rarityList,
      maxUpgradeLevel: MAX_UPGRADE_LEVEL
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/profile") {
    const token = url.searchParams.get("token");
    const profile = token ? profiles.get(token) : null;
    if (!profile) {
      sendJson(res, 404, { error: "Profile not found" });
      return;
    }

    sendJson(res, 200, { profile: publicProfile(profile) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/migrate") {
    const body = await readBody(req);
    const token = typeof body.token === "string" ? body.token : "";
    const profile = profiles.get(token);
    if (!profile) {
      sendJson(res, 404, { error: "Profile not found" });
      return;
    }

    mergeMigratedProfile(profile, body.profile);
    scheduleProfilesSave();

    const player = playerSessions.get(token);
    if (player) {
      player.profile = profile;
      player.name = profile.name;
      applyProfileLoadout(player, profile.selectedSpecies, profile.selectedVariants[profile.selectedSpecies]);
      emitProfile(player);
      emitSnapshot(player);
    }

    sendJson(res, 200, { profile: publicProfile(profile) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/profile") {
    const body = await readBody(req);
    const token = typeof body.token === "string" ? body.token : "";

    try {
      const result = performProfileAction(token, body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/join") {
    try {
      const body = await readBody(req);
      const roomId = sanitizeRoomId(body.roomId);
      const name = sanitizeName(body.name);

      let token = typeof body.token === "string" ? body.token : "";
      let player = token ? playerSessions.get(token) : null;
      if (!token || !profiles.has(token)) {
        token = crypto.randomUUID();
      }

      const profile = getOrCreateProfile(token, name);
      const loadout = {
        speciesId: body.speciesId || profile.selectedSpecies,
        variantId: body.variantId || profile.selectedVariants[profile.selectedSpecies]
      };

      if (!player) {
        player = createPlayer(token, roomId, name, profile, loadout);
        playerSessions.set(token, player);
      }

      if (player.roomId !== roomId) {
        movePlayerToRoom(player, roomId);
      }

      player.profile = profile;
      player.name = name;
      player.ip = clientIp(req);
      applySelectedVariant(profile, loadout.speciesId, loadout.variantId);
      normalizeProfileInPlace(profile);
      applyProfileLoadout(player, profile.selectedSpecies, profile.selectedVariants[profile.selectedSpecies]);
      player.lastSeen = Date.now();
      getRoom(roomId).players.set(token, player);

      const shareUrl = `${url.protocol}//${url.host}/?room=${roomId}`;
      sendJson(res, 200, {
        token,
        roomId,
        shareUrl,
        wsPath: "/ws",
        species: SPECIES,
        rarities: rarityList,
        maxUpgradeLevel: MAX_UPGRADE_LEVEL,
        profile: publicProfile(profile)
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

  if (req.method === "POST" && url.pathname === "/api/input") {
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
    return;
  }

  if (req.method === "GET") {
    serveStatic(url.pathname, res);
    return;
  }

  sendText(res, 405, "Method not allowed");
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    log("error", "Request failed", { error: error.message, method: req.method, url: req.url });
    sendJson(res, 500, { error: "Internal server error" });
  });
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket, req, player) => {
  if (player.socket && player.socket !== socket && player.socket.readyState === WebSocket.OPEN) {
    player.socket.close(4001, "replaced");
  }

  socket.isAlive = true;
  socket.playerToken = player.token;
  player.socket = socket;
  player.lastSeen = Date.now();

  socket.on("pong", () => {
    socket.isAlive = true;
    player.lastSeen = Date.now();
  });

  socket.on("message", (buffer) => {
    if (!consumeRateLimit(`ws:${player.token}`, RATE_LIMITS.websocket)) {
      socket.close(1008, "rate-limit");
      return;
    }

    let message;
    try {
      message = JSON.parse(buffer.toString("utf8"));
    } catch {
      socket.close(1003, "invalid-json");
      return;
    }

    if (message.type === "input") {
      player.inputX = clamp(Number(message.x) || 0, -1, 1);
      player.inputY = clamp(Number(message.y) || 0, -1, 1);
      player.boosting = Boolean(message.boost);
      player.lastSeen = Date.now();
      return;
    }

    if (message.type === "ping") {
      emit(socket, { type: "pong", now: Date.now() });
    }
  });

  socket.on("close", () => {
    if (player.socket === socket) {
      player.socket = null;
    }
    player.lastSeen = Date.now();
  });

  emit(socket, { type: "ready", now: Date.now(), roomId: player.roomId });
  emitProfile(player);
  emitSnapshot(player);
});

server.on("upgrade", (req, socket, head) => {
  if (shuttingDown) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!consumeRateLimit(`upgrade:${clientIp(req)}`, RATE_LIMITS.http)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("token");
  const player = token ? playerSessions.get(token) : null;
  if (!player) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, player);
  });
});

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log("info", "Shutting down", { signal });

  clearInterval(tickTimer);
  clearInterval(heartbeatTimer);

  for (const client of wss.clients) {
    client.close(1012, "server-restart");
  }

  server.close(() => {
    flushProfilesSync();
    log("info", "Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    flushProfilesSync();
    process.exit(1);
  }, 10000).unref?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", flushProfilesSync);

tickTimer = setInterval(tickRooms, TICK_MS);
heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }

    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  log("info", "Grow multiplayer listening", { port: PORT });
});
