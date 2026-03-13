const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const joinForm = document.getElementById("joinForm");
const joinPanel = document.getElementById("joinPanel");
const hudPanel = document.getElementById("hudPanel");
const unlockPanel = document.getElementById("unlockPanel");
const nameInput = document.getElementById("nameInput");
const speciesGrid = document.getElementById("speciesGrid");
const leaderboardList = document.getElementById("leaderboardList");
const speciesLabel = document.getElementById("speciesLabel");
const massLabel = document.getElementById("massLabel");
const bestLabel = document.getElementById("bestLabel");
const hostLabel = document.getElementById("hostLabel");
const statusLabel = document.getElementById("statusLabel");
const toast = document.getElementById("toast");

const SPECIES = [
  { id: "sprout", label: "Sprout Fry", unlockScore: 0, color: "#f6c555", accent: "#fff0b7", speed: 212, accel: 455, boostCost: 0.06 },
  { id: "dartfin", label: "Dartfin", unlockScore: 90, color: "#ff8a5b", accent: "#ffd6bb", speed: 228, accel: 485, boostCost: 0.075 },
  { id: "reefglider", label: "Reef Glider", unlockScore: 220, color: "#3ec7c2", accent: "#cbfffb", speed: 198, accel: 425, boostCost: 0.055 },
  { id: "puffer", label: "Puffer Bruiser", unlockScore: 420, color: "#6bb0ff", accent: "#e3f1ff", speed: 182, accel: 400, boostCost: 0.045 },
  { id: "abyssal", label: "Abyssal Hunter", unlockScore: 650, color: "#9f7cff", accent: "#f0e8ff", speed: 206, accel: 440, boostCost: 0.08 }
];

const WORLD = { width: 4200, height: 2600 };
const START_MASS = 24;
const MAX_FOOD = 140;
const MAX_BOTS = 16;
const PLAYER_TIMEOUT_MS = 6000;
const SNAPSHOT_MS = 90;
const HEARTBEAT_MS = 1000;
const TICK_MS = 1000 / 30;
const CHANNEL_NAME = "grow-ocean-pages-v1";
const PROFILE_KEY = "grow-profile";
const TAB_ID_KEY = "grow-tab-id";
const OPENED_AT_KEY = "grow-opened-at";

const speciesById = Object.fromEntries(SPECIES.map((species) => [species.id, species]));
const channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL_NAME) : null;

let nextFoodId = 1;
let nextBotId = 1;
let toastTimer = null;

const profile = loadProfile();
const runtime = {
  joined: false,
  tabId: getSessionValue(TAB_ID_KEY, () => crypto.randomUUID()),
  openedAt: Number(getSessionValue(OPENED_AT_KEY, () => String(Date.now() + Math.random()))),
  isHost: false,
  hostId: null,
  lastFrame: performance.now(),
  accumulator: 0,
  pointer: { x: 0, y: 0, active: false },
  keys: new Set(),
  peers: new Map(),
  inputs: new Map(),
  snapshot: null,
  lastPresenceAt: 0,
  lastHeartbeatAt: 0,
  lastInputSentAt: 0,
  lastSnapshotAt: 0,
  hostSnapshotAt: 0,
  lastHostCheckAt: 0,
  hostHeartbeatAt: 0,
  camera: { x: 0, y: 0, zoom: 1 }
};

const world = {
  players: new Map(),
  foods: [],
  bots: [],
  tick: 0
};

nameInput.value = profile.name;

function loadProfile() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || "");
    return {
      name: parsed.name || "",
      bestScore: parsed.bestScore || 0,
      unlockedSpecies: Array.isArray(parsed.unlockedSpecies) ? parsed.unlockedSpecies : ["sprout"],
      selectedSpecies: speciesById[parsed.selectedSpecies] ? parsed.selectedSpecies : "sprout"
    };
  } catch (error) {
    return {
      name: "",
      bestScore: 0,
      unlockedSpecies: ["sprout"],
      selectedSpecies: "sprout"
    };
  }
}

function saveProfile() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function getSessionValue(key, create) {
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = create();
    sessionStorage.setItem(key, value);
  }
  return value;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function random(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalize(x, y) {
  const length = Math.hypot(x, y);
  return length ? { x: x / length, y: y / length } : { x: 0, y: 0 };
}

function massToRadius(mass) {
  return 7 + Math.sqrt(mass) * 3;
}

function getSpecies(speciesId) {
  return speciesById[speciesId] || SPECIES[0];
}

function currentInput() {
  let x = 0;
  let y = 0;

  if (runtime.keys.has("KeyA")) x -= 1;
  if (runtime.keys.has("KeyD")) x += 1;
  if (runtime.keys.has("KeyW")) y -= 1;
  if (runtime.keys.has("KeyS")) y += 1;

  if (x === 0 && y === 0 && runtime.pointer.active) {
    x = runtime.pointer.x - window.innerWidth / 2;
    y = runtime.pointer.y - window.innerHeight / 2;
  }

  const vector = normalize(x, y);
  return {
    x: Math.abs(x) < 12 ? 0 : vector.x,
    y: Math.abs(y) < 12 ? 0 : vector.y,
    boost: runtime.keys.has("Space") || runtime.keys.has("ShiftLeft") || runtime.keys.has("ShiftRight")
  };
}

function createFood() {
  const palette = ["#ffcf5c", "#6ae9d0", "#ff7a8a", "#84a9ff", "#ffd3ee", "#9cff71"];
  return {
    id: `food-${nextFoodId++}`,
    x: random(60, WORLD.width - 60),
    y: random(60, WORLD.height - 60),
    radius: random(3.5, 6.5),
    value: random(2.5, 7),
    color: palette[Math.floor(Math.random() * palette.length)]
  };
}

function createBot() {
  const mass = random(18, 150);
  const tier = mass > 115 ? "puffer" : mass > 70 ? "reefglider" : mass > 40 ? "dartfin" : "sprout";
  return {
    id: `bot-${nextBotId++}`,
    name: ["Nib", "Reef", "Glint", "Snap", "Drift", "Ripple"][Math.floor(Math.random() * 6)],
    speciesId: tier,
    x: random(120, WORLD.width - 120),
    y: random(120, WORLD.height - 120),
    vx: 0,
    vy: 0,
    inputX: random(-1, 1),
    inputY: random(-1, 1),
    boosting: false,
    mass,
    score: Math.max(0, mass - START_MASS),
    radius: massToRadius(mass),
    wanderAt: 0
  };
}

function resetWorld() {
  world.players.clear();
  world.foods.length = 0;
  world.bots.length = 0;
  world.tick = 0;
  nextFoodId = 1;
  nextBotId = 1;
  while (world.foods.length < MAX_FOOD) world.foods.push(createFood());
  while (world.bots.length < MAX_BOTS) world.bots.push(createBot());
}

function createPlayer(peer) {
  return {
    id: peer.id,
    name: peer.name,
    speciesId: peer.selectedSpecies,
    x: random(240, WORLD.width - 240),
    y: random(240, WORLD.height - 240),
    vx: 0,
    vy: 0,
    inputX: 0,
    inputY: 0,
    boosting: false,
    mass: START_MASS,
    score: 0,
    radius: massToRadius(START_MASS),
    alive: true,
    respawnAt: 0,
    defeatedBy: "",
    streak: 0,
    bestScore: peer.bestScore || 0
  };
}

function getMoveStats(actor) {
  const species = getSpecies(actor.speciesId);
  const sizePenalty = clamp((actor.mass - START_MASS) * 0.18, 0, 125);
  return {
    maxSpeed: Math.max(82, species.speed - sizePenalty),
    accel: species.accel,
    boostCost: species.boostCost
  };
}

function applyMovement(actor, dt) {
  const desired = normalize(actor.inputX, actor.inputY);
  const stats = getMoveStats(actor);

  actor.vx += desired.x * stats.accel * dt;
  actor.vy += desired.y * stats.accel * dt;

  if (actor.boosting && actor.mass > START_MASS + 5) {
    actor.vx += desired.x * stats.accel * 0.8 * dt;
    actor.vy += desired.y * stats.accel * 0.8 * dt;
    actor.mass = Math.max(START_MASS, actor.mass - stats.boostCost);
    actor.score = Math.max(0, actor.mass - START_MASS);
    actor.radius = massToRadius(actor.mass);
  }

  const drag = Math.pow(0.91, dt * 60);
  actor.vx *= drag;
  actor.vy *= drag;

  const speed = Math.hypot(actor.vx, actor.vy);
  const cap = stats.maxSpeed * (actor.boosting ? 1.16 : 1);
  if (speed > cap) {
    actor.vx = (actor.vx / speed) * cap;
    actor.vy = (actor.vy / speed) * cap;
  }

  actor.x = clamp(actor.x + actor.vx * dt, actor.radius, WORLD.width - actor.radius);
  actor.y = clamp(actor.y + actor.vy * dt, actor.radius, WORLD.height - actor.radius);
}

function grow(actor, amount) {
  actor.mass += amount;
  actor.score = Math.max(actor.score, actor.mass - START_MASS);
  actor.radius = massToRadius(actor.mass);
  actor.bestScore = Math.max(actor.bestScore || 0, Math.floor(actor.score));
}

function respawnPlayer(player) {
  const peer = runtime.peers.get(player.id);
  player.x = random(240, WORLD.width - 240);
  player.y = random(240, WORLD.height - 240);
  player.vx = 0;
  player.vy = 0;
  player.inputX = 0;
  player.inputY = 0;
  player.boosting = false;
  player.mass = START_MASS;
  player.score = 0;
  player.radius = massToRadius(START_MASS);
  player.alive = true;
  player.respawnAt = 0;
  player.defeatedBy = "";
  player.streak = 0;
  player.speciesId = peer?.selectedSpecies || player.speciesId;
}

function defeatPlayer(player, byName) {
  player.alive = false;
  player.respawnAt = performance.now() + 2400;
  player.defeatedBy = byName;
}

function ensurePopulation() {
  while (world.foods.length < MAX_FOOD) world.foods.push(createFood());
  while (world.bots.length < MAX_BOTS) world.bots.push(createBot());
}

function updateBots(now, dt) {
  const players = [...world.players.values()].filter((player) => player.alive);

  for (const bot of world.bots) {
    if (now >= bot.wanderAt) {
      const threat = players.find((player) => distance(bot, player) < 250 && player.mass > bot.mass * 1.18);
      const prey = players.find((player) => distance(bot, player) < 320 && bot.mass > player.mass * 1.18);

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

    bot.boosting = Math.random() < 0.025;
    applyMovement(bot, dt);
  }
}

function consumeFoodsFor(actor, multiplier) {
  for (let index = world.foods.length - 1; index >= 0; index -= 1) {
    const food = world.foods[index];
    if (distance(actor, food) <= actor.radius + food.radius) {
      grow(actor, food.value * multiplier);
      world.foods.splice(index, 1);
    }
  }
}

function canEat(predator, prey) {
  return predator.mass > prey.mass * 1.12 && distance(predator, prey) < predator.radius * 0.9;
}

function respawnBot(index) {
  world.bots[index] = createBot();
}

function resolveEncounters() {
  const players = [...world.players.values()].filter((player) => player.alive);

  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i];
      const b = players[j];
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

  for (const player of players) {
    for (let index = world.bots.length - 1; index >= 0; index -= 1) {
      const bot = world.bots[index];
      if (canEat(player, bot)) {
        grow(player, bot.mass * 0.48);
        player.streak += 1;
        respawnBot(index);
      } else if (canEat(bot, player)) {
        grow(bot, player.mass * 0.5);
        defeatPlayer(player, bot.name);
      }
    }
  }
}

function buildSnapshot() {
  return {
    world: WORLD,
    players: [...world.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      speciesId: player.speciesId,
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      radius: player.radius,
      mass: player.mass,
      score: Math.floor(player.score),
      bestScore: Math.floor(player.bestScore || 0),
      streak: player.streak,
      alive: player.alive,
      respawnAt: player.respawnAt,
      defeatedBy: player.defeatedBy
    })),
    bots: world.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      speciesId: bot.speciesId,
      x: bot.x,
      y: bot.y,
      vx: bot.vx,
      vy: bot.vy,
      radius: bot.radius,
      mass: bot.mass
    })),
    foods: world.foods.map((food) => ({
      id: food.id,
      x: food.x,
      y: food.y,
      radius: food.radius,
      color: food.color
    })),
    leaderboard: [...world.players.values()]
      .filter((player) => player.alive)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((player) => ({ id: player.id, name: player.name, score: Math.floor(player.score), speciesId: player.speciesId }))
  };
}

function hostStep(now, dt) {
  for (const [id, peer] of runtime.peers) {
    if (now - peer.seenAt > PLAYER_TIMEOUT_MS) {
      runtime.peers.delete(id);
      world.players.delete(id);
    }
  }

  for (const peer of runtime.peers.values()) {
    let player = world.players.get(peer.id);
    if (!player) {
      player = createPlayer(peer);
      world.players.set(peer.id, player);
    }
    player.name = peer.name;
    player.speciesId = peer.selectedSpecies;
    player.bestScore = Math.max(player.bestScore || 0, peer.bestScore || 0);
  }

  for (const player of world.players.values()) {
    if (!player.alive) {
      if (now >= player.respawnAt) {
        respawnPlayer(player);
      }
      continue;
    }

    const input = runtime.inputs.get(player.id) || { x: 0, y: 0, boost: false };
    player.inputX = input.x;
    player.inputY = input.y;
    player.boosting = input.boost;
    applyMovement(player, dt);
    consumeFoodsFor(player, 1);
  }

  updateBots(now, dt);

  for (const bot of world.bots) {
    consumeFoodsFor(bot, 0.75);
  }

  resolveEncounters();
  ensurePopulation();
  world.tick += 1;

  if (channel && now - runtime.hostSnapshotAt >= SNAPSHOT_MS) {
    runtime.hostSnapshotAt = now;
    channel.postMessage({
      type: "snapshot",
      hostId: runtime.tabId,
      snapshot: buildSnapshot()
    });
  }

  if (channel && now - runtime.lastHeartbeatAt >= HEARTBEAT_MS) {
    runtime.lastHeartbeatAt = now;
    broadcastPresence();
  }

  runtime.snapshot = buildSnapshot();
}

function selfPeer() {
  return {
    id: runtime.tabId,
    rank: runtime.openedAt,
    name: profile.name || "Shoal Scout",
    selectedSpecies: profile.selectedSpecies,
    bestScore: profile.bestScore,
    seenAt: performance.now()
  };
}

function evaluateHost() {
  if (!runtime.joined) {
    runtime.isHost = false;
    runtime.hostId = null;
    return;
  }

  const now = performance.now();
  const activePeers = [...runtime.peers.values()].filter((peer) => now - peer.seenAt < PLAYER_TIMEOUT_MS);
  activePeers.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const nextHost = activePeers[0]?.id || runtime.tabId;
  const changed = runtime.hostId !== nextHost;
  runtime.hostId = nextHost;
  runtime.isHost = nextHost === runtime.tabId;

  if (runtime.isHost && changed) {
    resetWorld();
    for (const peer of activePeers) {
      world.players.set(peer.id, createPlayer(peer));
      runtime.inputs.set(peer.id, { x: 0, y: 0, boost: false });
    }
    runtime.snapshot = buildSnapshot();
    showToast("This tab is now the host.");
  }
}

function broadcastPresence() {
  if (!runtime.joined || !channel) {
    return;
  }

  const message = {
    type: "presence",
    id: runtime.tabId,
    rank: runtime.openedAt,
    name: profile.name || "Shoal Scout",
    selectedSpecies: profile.selectedSpecies,
    bestScore: profile.bestScore
  };
  channel.postMessage(message);
  runtime.lastPresenceAt = performance.now();
}

function handleChannelMessage(event) {
  const message = event.data;
  if (!message || !runtime.joined || message.id === runtime.tabId) {
    return;
  }

  const now = performance.now();

  if (message.type === "presence") {
    runtime.peers.set(message.id, {
      id: message.id,
      rank: message.rank,
      name: message.name,
      selectedSpecies: message.selectedSpecies,
      bestScore: message.bestScore || 0,
      seenAt: now
    });
    evaluateHost();
    return;
  }

  if (message.type === "input" && runtime.isHost) {
    runtime.inputs.set(message.id, message.input);
    const peer = runtime.peers.get(message.id);
    if (peer) {
      peer.seenAt = now;
    }
    return;
  }

  if (message.type === "snapshot" && !runtime.isHost) {
    runtime.hostId = message.hostId;
    runtime.snapshot = message.snapshot;
    runtime.lastSnapshotAt = now;
    return;
  }

  if (message.type === "leave") {
    runtime.peers.delete(message.id);
    runtime.inputs.delete(message.id);
    world.players.delete(message.id);
    evaluateHost();
  }
}

if (channel) {
  channel.addEventListener("message", handleChannelMessage);
}

function joinGame(name) {
  profile.name = name || "Shoal Scout";
  saveProfile();
  runtime.joined = true;

  joinPanel.classList.add("hidden");
  hudPanel.classList.remove("hidden");
  unlockPanel.classList.remove("hidden");

  runtime.peers.set(runtime.tabId, selfPeer());
  evaluateHost();
  broadcastPresence();
  renderSpeciesCards();
  showToast(channel ? "Joined the shared ocean." : "BroadcastChannel unavailable: running single-player.");
}

function syncInput(now) {
  if (!runtime.joined) {
    return;
  }

  const input = currentInput();
  runtime.inputs.set(runtime.tabId, input);

  const peer = runtime.peers.get(runtime.tabId);
  if (peer) {
    peer.seenAt = now;
    peer.name = profile.name || "Shoal Scout";
    peer.selectedSpecies = profile.selectedSpecies;
    peer.bestScore = profile.bestScore;
  }

  if (runtime.isHost || !channel) {
    return;
  }

  if (now - runtime.lastInputSentAt > 70) {
    runtime.lastInputSentAt = now;
    channel.postMessage({
      type: "input",
      id: runtime.tabId,
      input
    });
  }
}

function getSelfFromSnapshot() {
  if (!runtime.snapshot) {
    return null;
  }
  return runtime.snapshot.players.find((player) => player.id === runtime.tabId) || null;
}

function applyUnlockProgress(self) {
  if (!self) {
    return;
  }

  const before = new Set(profile.unlockedSpecies);
  const previousBest = profile.bestScore;
  profile.bestScore = Math.max(profile.bestScore, Math.floor(self.bestScore || self.score || 0));
  let changed = previousBest !== profile.bestScore;

  for (const species of SPECIES) {
    if (profile.bestScore >= species.unlockScore && !profile.unlockedSpecies.includes(species.id)) {
      profile.unlockedSpecies.push(species.id);
      showToast(`Unlocked ${species.label}`);
      changed = true;
    }
  }

  if (!before.has(profile.selectedSpecies) && !profile.unlockedSpecies.includes(profile.selectedSpecies)) {
    profile.selectedSpecies = "sprout";
    changed = true;
  }

  if (changed) {
    saveProfile();
    renderSpeciesCards();
    broadcastPresence();
  }

  const peer = runtime.peers.get(runtime.tabId);
  if (peer) {
    peer.bestScore = profile.bestScore;
  }
}

function renderSpeciesCards() {
  speciesGrid.innerHTML = "";
  for (const species of SPECIES) {
    const locked = !profile.unlockedSpecies.includes(species.id);
    const selected = profile.selectedSpecies === species.id;
    const card = document.createElement("article");
    card.className = `species-card${locked ? " locked" : ""}${selected ? " selected" : ""}`;

    card.innerHTML = `
      <header>
        <strong><span class="species-swatch" style="background:${species.color}; color:${species.color}"></span>${species.label}</strong>
        <span>${locked ? "Locked" : "Ready"}</span>
      </header>
      <div class="species-meta">
        <span>Unlock score ${species.unlockScore}</span>
        <span>Speed ${Math.round(species.speed)}</span>
      </div>
      <button ${locked ? "disabled" : ""} data-species="${species.id}">${selected ? "Selected" : locked ? `Need ${species.unlockScore}` : "Switch"}</button>
    `;

    speciesGrid.appendChild(card);
  }

  speciesGrid.querySelectorAll("button[data-species]").forEach((button) => {
    button.addEventListener("click", () => {
      const speciesId = button.dataset.species;
      if (!profile.unlockedSpecies.includes(speciesId)) {
        return;
      }

      profile.selectedSpecies = speciesId;
      saveProfile();

      const peer = runtime.peers.get(runtime.tabId);
      if (peer) {
        peer.selectedSpecies = speciesId;
      }

      if (runtime.isHost) {
        const player = world.players.get(runtime.tabId);
        if (player) {
          player.speciesId = speciesId;
        }
      }

      broadcastPresence();
      renderSpeciesCards();
    });
  });
}

function updateHud(self) {
  const species = getSpecies(self?.speciesId || profile.selectedSpecies);
  speciesLabel.textContent = species.label;
  massLabel.textContent = String(Math.round(self?.mass || START_MASS));
  bestLabel.textContent = String(profile.bestScore);
  hostLabel.textContent = runtime.isHost ? "Yes" : "No";

  if (!runtime.joined) {
    statusLabel.textContent = "Waiting";
  } else if (!channel) {
    statusLabel.textContent = "Single-player";
  } else if (runtime.isHost) {
    statusLabel.textContent = "Hosting";
  } else {
    statusLabel.textContent = "Synced";
  }

  leaderboardList.innerHTML = "";
  for (const entry of runtime.snapshot?.leaderboard || []) {
    const item = document.createElement("li");
    item.innerHTML = `<span>${entry.name}</span><strong>${entry.score}</strong>`;
    leaderboardList.appendChild(item);
  }
}

function resize() {
  canvas.width = window.innerWidth * window.devicePixelRatio;
  canvas.height = window.innerHeight * window.devicePixelRatio;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

function worldToScreen(x, y) {
  return {
    x: (x - runtime.camera.x) * runtime.camera.zoom + window.innerWidth / 2,
    y: (y - runtime.camera.y) * runtime.camera.zoom + window.innerHeight / 2
  };
}

function drawBackground() {
  const gradient = ctx.createLinearGradient(0, 0, 0, window.innerHeight);
  gradient.addColorStop(0, "#4ab7d8");
  gradient.addColorStop(0.32, "#185681");
  gradient.addColorStop(1, "#031424");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  const grid = 170 * runtime.camera.zoom;
  const offsetX = (-runtime.camera.x * runtime.camera.zoom) % grid;
  const offsetY = (-runtime.camera.y * runtime.camera.zoom) % grid;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let x = offsetX; x < window.innerWidth; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, window.innerHeight);
    ctx.stroke();
  }
  for (let y = offsetY; y < window.innerHeight; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(window.innerWidth, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFood(food) {
  const point = worldToScreen(food.x, food.y);
  const radius = food.radius * runtime.camera.zoom;
  if (point.x < -radius || point.y < -radius || point.x > window.innerWidth + radius || point.y > window.innerHeight + radius) {
    return;
  }

  const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 2.5);
  glow.addColorStop(0, food.color);
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius * 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = food.color;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawFish(entity, self) {
  const point = worldToScreen(entity.x, entity.y);
  const radius = entity.radius * runtime.camera.zoom;
  if (point.x < -radius * 2 || point.y < -radius * 2 || point.x > window.innerWidth + radius * 2 || point.y > window.innerHeight + radius * 2) {
    return;
  }

  const species = getSpecies(entity.speciesId);
  const angle = Math.atan2(entity.vy || 0.0001, entity.vx || 1);

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);

  const body = ctx.createLinearGradient(-radius, 0, radius, 0);
  body.addColorStop(0, species.accent);
  body.addColorStop(1, species.color);

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 1.18, radius * 0.76, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = species.color;
  ctx.beginPath();
  ctx.moveTo(-radius * 1.1, 0);
  ctx.lineTo(-radius * 1.9, radius * 0.7);
  ctx.lineTo(-radius * 1.9, -radius * 0.7);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(radius * 0.42, -radius * 0.12, Math.max(2.5, radius * 0.11), 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#09253a";
  ctx.beginPath();
  ctx.arc(radius * 0.44, -radius * 0.12, Math.max(1.2, radius * 0.045), 0, Math.PI * 2);
  ctx.fill();

  if (self) {
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 1.34, radius * 0.92, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  ctx.fillStyle = "rgba(240,250,255,0.96)";
  ctx.font = '600 13px "Bahnschrift", "Trebuchet MS", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(entity.name, point.x, point.y - radius - 14);
}

function drawBounds() {
  const topLeft = worldToScreen(0, 0);
  const bottomRight = worldToScreen(WORLD.width, WORLD.height);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 4;
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.restore();
}

function drawDeathOverlay(self) {
  if (!self || self.alive) {
    return;
  }

  const seconds = Math.max(0, Math.ceil((self.respawnAt - performance.now()) / 1000));
  ctx.save();
  ctx.fillStyle = "rgba(3, 8, 18, 0.42)";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.fillStyle = "#eef8ff";
  ctx.textAlign = "center";
  ctx.font = '700 36px "Impact", "Haettenschweiler", "Arial Narrow Bold", sans-serif';
  ctx.fillText("You got eaten", window.innerWidth / 2, window.innerHeight / 2 - 12);
  ctx.font = '500 18px "Bahnschrift", "Trebuchet MS", sans-serif';
  ctx.fillText(`Defeated by ${self.defeatedBy || "a larger fish"} • respawn in ${seconds}s`, window.innerWidth / 2, window.innerHeight / 2 + 22);
  ctx.restore();
}

function render(now) {
  const delta = Math.min(50, now - runtime.lastFrame);
  runtime.lastFrame = now;
  runtime.accumulator += delta;

  if (runtime.joined && channel && !runtime.isHost && now - runtime.lastHostCheckAt > 1200) {
    runtime.lastHostCheckAt = now;
    evaluateHost();
  }

  syncInput(now);

  while (runtime.accumulator >= TICK_MS) {
    runtime.accumulator -= TICK_MS;
    if (runtime.joined && (runtime.isHost || !channel)) {
      hostStep(now, TICK_MS / 1000);
    } else if (runtime.joined && now - runtime.lastPresenceAt > HEARTBEAT_MS) {
      broadcastPresence();
    }
  }

  const self = getSelfFromSnapshot();
  applyUnlockProgress(self);
  updateHud(self);

  if (self) {
    const targetZoom = Math.max(0.4, Math.min(0.95, 1.15 - self.radius / 150));
    runtime.camera.x += (self.x - runtime.camera.x) * 0.14;
    runtime.camera.y += (self.y - runtime.camera.y) * 0.14;
    runtime.camera.zoom += (targetZoom - runtime.camera.zoom) * 0.08;
  }

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawBackground();

  if (runtime.snapshot) {
    drawBounds();
    for (const food of runtime.snapshot.foods) drawFood(food);
    for (const bot of runtime.snapshot.bots) drawFish(bot, false);
    for (const player of runtime.snapshot.players) {
      if (player.id !== runtime.tabId) {
        drawFish(player, false);
      }
    }
    if (self) {
      drawFish(self, true);
      drawDeathOverlay(self);
    }
  }

  requestAnimationFrame(render);
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (runtime.joined) {
    return;
  }
  joinGame(nameInput.value.trim());
});

window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code)) {
    runtime.keys.add(event.code);
    if (event.code === "Space") {
      event.preventDefault();
    }
  }
});
window.addEventListener("keyup", (event) => runtime.keys.delete(event.code));

canvas.addEventListener("mousemove", (event) => {
  runtime.pointer.x = event.clientX;
  runtime.pointer.y = event.clientY;
  runtime.pointer.active = true;
});
canvas.addEventListener("mouseleave", () => {
  runtime.pointer.active = false;
});
canvas.addEventListener("touchstart", (event) => {
  const touch = event.touches[0];
  if (!touch) return;
  runtime.pointer.x = touch.clientX;
  runtime.pointer.y = touch.clientY;
  runtime.pointer.active = true;
}, { passive: true });
canvas.addEventListener("touchmove", (event) => {
  const touch = event.touches[0];
  if (!touch) return;
  runtime.pointer.x = touch.clientX;
  runtime.pointer.y = touch.clientY;
  runtime.pointer.active = true;
}, { passive: true });
canvas.addEventListener("touchend", () => {
  runtime.pointer.active = false;
}, { passive: true });

window.addEventListener("beforeunload", () => {
  if (channel && runtime.joined) {
    channel.postMessage({ type: "leave", id: runtime.tabId });
  }
});

resize();
renderSpeciesCards();
requestAnimationFrame(render);
