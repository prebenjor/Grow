const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const joinForm = document.getElementById("joinForm");
const joinPanel = document.getElementById("joinPanel");
const hudPanel = document.getElementById("hudPanel");
const unlockPanel = document.getElementById("unlockPanel");
const unlockToggle = document.getElementById("unlockToggle");
const closeUnlocksButton = document.getElementById("closeUnlocksButton");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const shareInput = document.getElementById("shareInput");
const copyInviteButton = document.getElementById("copyInviteButton");
const speciesGrid = document.getElementById("speciesGrid");
const leaderboardList = document.getElementById("leaderboardList");
const speciesLabel = document.getElementById("speciesLabel");
const massLabel = document.getElementById("massLabel");
const pearlsLabel = document.getElementById("pearlsLabel");
const bestLabel = document.getElementById("bestLabel");
const streakLabel = document.getElementById("streakLabel");
const statusLabel = document.getElementById("statusLabel");
const drawerPearlsLabel = document.getElementById("drawerPearlsLabel");
const drawerRoomLabel = document.getElementById("drawerRoomLabel");
const toast = document.getElementById("toast");

const PROFILE_CACHE_KEY = "grow-profile-cache";
const LEGACY_PROFILE_KEY = "grow-profile";
const MIGRATION_KEY_PREFIX = "grow-migrated:";
const CLIENT_ID = localStorage.getItem("grow-client-id") || crypto.randomUUID();

localStorage.setItem("grow-client-id", CLIENT_ID);

const state = {
  token: localStorage.getItem("grow-token") || "",
  roomId: new URLSearchParams(window.location.search).get("room") || "",
  snapshot: null,
  connected: false,
  config: null,
  species: [],
  rarities: [],
  maxUpgradeLevel: 5,
  profile: createDefaultProfile(),
  pointer: { x: 0, y: 0, active: false },
  keys: new Set(),
  camera: { x: 0, y: 0, zoom: 1 },
  lastFrame: performance.now(),
  speciesRenderKey: "",
  toastTimer: null,
  unlockPanelOpen: window.innerWidth > 980,
  socket: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  lastInputKey: "",
  socketReady: false
};

function createDefaultProfile() {
  return {
    name: "",
    bestScore: 0,
    pearls: 0,
    unlockedSpecies: ["sprout"],
    selectedSpecies: "sprout",
    ownedVariants: {},
    selectedVariants: {},
    upgrades: {}
  };
}

function loadCachedProfile() {
  try {
    const cached = localStorage.getItem(PROFILE_CACHE_KEY) || localStorage.getItem(LEGACY_PROFILE_KEY) || "";
    const parsed = JSON.parse(cached);
    return {
      ...createDefaultProfile(),
      ...parsed,
      unlockedSpecies: Array.isArray(parsed.unlockedSpecies) ? parsed.unlockedSpecies : ["sprout"],
      ownedVariants: parsed.ownedVariants && typeof parsed.ownedVariants === "object" ? parsed.ownedVariants : {},
      selectedVariants: parsed.selectedVariants && typeof parsed.selectedVariants === "object" ? parsed.selectedVariants : {},
      upgrades: parsed.upgrades && typeof parsed.upgrades === "object" ? parsed.upgrades : {}
    };
  } catch (error) {
    return createDefaultProfile();
  }
}

function loadLegacyProfile() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_PROFILE_KEY) || "");
    return {
      ...createDefaultProfile(),
      ...parsed,
      unlockedSpecies: Array.isArray(parsed.unlockedSpecies) ? parsed.unlockedSpecies : ["sprout"],
      ownedVariants: parsed.ownedVariants && typeof parsed.ownedVariants === "object" ? parsed.ownedVariants : {},
      selectedVariants: parsed.selectedVariants && typeof parsed.selectedVariants === "object" ? parsed.selectedVariants : {},
      upgrades: parsed.upgrades && typeof parsed.upgrades === "object" ? parsed.upgrades : {}
    };
  } catch (error) {
    return null;
  }
}

state.profile = loadCachedProfile();
nameInput.value = state.profile.name;
roomInput.value = state.roomId;

function saveProfileCache() {
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(state.profile));
}

function resize() {
  const scale = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = window.innerWidth * scale;
  canvas.height = window.innerHeight * scale;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
}

function setUnlockPanelOpen(nextOpen) {
  state.unlockPanelOpen = nextOpen;
  document.body.classList.toggle("unlocks-open", nextOpen);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    cache: "no-store",
    ...options
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function sanitizeRoomId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 24);
}

function randomRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getSpecies(speciesId) {
  return (
    state.species.find((entry) => entry.id === speciesId) ||
    state.species[0] || {
      id: "sprout",
      label: "Sprout Fry",
      color: "#f6c555",
      accent: "#fff0b7",
      variants: [{ id: "sprout-native", label: "Sprout Fry Native", rarity: "common", color: "#f6c555", accent: "#fff0b7" }]
    }
  );
}

function getRarity(rarityId) {
  return state.rarities.find((entry) => entry.id === rarityId) || { id: "common", label: "Common", ring: "#d9e4ee", weight: 1 };
}

function normalizeProfileAgainstConfig() {
  if (!state.species.length) {
    return;
  }

  let changed = false;

  for (const species of state.species) {
    const baseVariant = species.variants[0];
    const owned = Array.isArray(state.profile.ownedVariants[species.id]) ? [...state.profile.ownedVariants[species.id]] : [];
    if (!owned.includes(baseVariant.id)) {
      owned.unshift(baseVariant.id);
      changed = true;
    }
    state.profile.ownedVariants[species.id] = [...new Set(owned)];

    if (!state.profile.selectedVariants[species.id] || !state.profile.ownedVariants[species.id].includes(state.profile.selectedVariants[species.id])) {
      state.profile.selectedVariants[species.id] = baseVariant.id;
      changed = true;
    }

    const upgradeLevel = clamp(Number(state.profile.upgrades[species.id]) || 0, 0, state.maxUpgradeLevel);
    if (state.profile.upgrades[species.id] !== upgradeLevel) {
      state.profile.upgrades[species.id] = upgradeLevel;
      changed = true;
    }
  }

  if (!state.profile.unlockedSpecies.includes("sprout")) {
    state.profile.unlockedSpecies.unshift("sprout");
    changed = true;
  }

  if (!state.profile.unlockedSpecies.includes(state.profile.selectedSpecies)) {
    state.profile.selectedSpecies = "sprout";
    changed = true;
  }

  if (changed) {
    saveProfileCache();
  }
}

function applyProfile(profile) {
  state.profile = {
    ...createDefaultProfile(),
    ...profile,
    unlockedSpecies: Array.isArray(profile?.unlockedSpecies) ? profile.unlockedSpecies : ["sprout"],
    ownedVariants: profile?.ownedVariants && typeof profile.ownedVariants === "object" ? profile.ownedVariants : {},
    selectedVariants: profile?.selectedVariants && typeof profile.selectedVariants === "object" ? profile.selectedVariants : {},
    upgrades: profile?.upgrades && typeof profile.upgrades === "object" ? profile.upgrades : {}
  };
  nameInput.value = state.profile.name;
  normalizeProfileAgainstConfig();
  saveProfileCache();
  renderSpeciesCards(true);
  updateHud();
}

function getSelectedVariant(speciesId) {
  const species = getSpecies(speciesId);
  const variants = Array.isArray(species.variants) && species.variants.length ? species.variants : [getSpecies("sprout").variants[0]];
  const variantId = state.profile.selectedVariants[speciesId] || variants[0].id;
  return variants.find((variant) => variant.id === variantId) || variants[0];
}

function getUpgradeLevel(speciesId) {
  return clamp(Number(state.profile.upgrades[speciesId]) || 0, 0, state.maxUpgradeLevel);
}

function currentLoadout() {
  const speciesId = state.profile.selectedSpecies;
  return {
    speciesId,
    variantId: getSelectedVariant(speciesId).id
  };
}

function updateShareLink(roomId, explicitShareUrl) {
  if (explicitShareUrl) {
    shareInput.value = explicitShareUrl;
  } else {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    shareInput.value = url.toString();
  }

  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  history.replaceState({}, "", `${url.pathname}?${url.searchParams.toString()}`);
}

async function loadConfig() {
  state.config = await request("/api/config");
  state.species = state.config.species;
  state.rarities = state.config.rarities;
  state.maxUpgradeLevel = state.config.maxUpgradeLevel;
  normalizeProfileAgainstConfig();
}

async function bootstrapProfile() {
  if (!state.token) {
    return;
  }

  try {
    const payload = await request(`/api/profile?token=${encodeURIComponent(state.token)}`);
    applyProfile(payload.profile);
  } catch (error) {
    localStorage.removeItem("grow-token");
    state.token = "";
  }
}

async function migrateLegacyProfileIfNeeded() {
  if (!state.token) {
    return;
  }

  const markerKey = `${MIGRATION_KEY_PREFIX}${state.token}`;
  if (localStorage.getItem(markerKey) === "1") {
    return;
  }

  const legacy = loadLegacyProfile();
  if (!legacy) {
    localStorage.setItem(markerKey, "1");
    return;
  }

  const payload = await request("/api/profile/migrate", {
    method: "POST",
    body: JSON.stringify({
      token: state.token,
      profile: legacy
    })
  });

  localStorage.setItem(markerKey, "1");
  applyProfile(payload.profile);
}

function variantDiscoveryCost(species) {
  return 12 + Math.floor(species.unlockScore / 18);
}

function upgradeCost(species, currentLevel) {
  return 18 + currentLevel * 26 + Math.floor(species.unlockScore / 12);
}

async function profileAction(action, speciesId, variantId) {
  if (!state.token) {
    showToast("Join a room first");
    return null;
  }

  const payload = await request("/api/profile", {
    method: "POST",
    body: JSON.stringify({
      token: state.token,
      action,
      speciesId,
      variantId,
      clientId: CLIENT_ID
    })
  });

  if (payload.profile) {
    applyProfile(payload.profile);
  }

  if (payload.message) {
    showToast(payload.message);
  }

  return payload;
}

function socketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(state.token)}`;
}

function sendSocket(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

function scheduleReconnect() {
  if (state.reconnectTimer || !state.token || !state.roomId) {
    return;
  }

  const delay = Math.min(5000, 800 + state.reconnectAttempts * 500);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.reconnectAttempts += 1;
    openSocket();
  }, delay);
}

function handleSocketMessage(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return;
  }

  if (payload.type === "ready") {
    state.socketReady = true;
    state.connected = true;
    state.reconnectAttempts = 0;
    sendInput(true);
    return;
  }

  if (payload.type === "snapshot") {
    state.snapshot = payload.snapshot;
    updateHud();
    return;
  }

  if (payload.type === "profile") {
    applyProfile(payload.profile);
    return;
  }

  if (payload.type === "event" && payload.message) {
    showToast(payload.message);
  }
}

function openSocket() {
  if (!state.token) {
    return;
  }

  if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) {
    return;
  }

  statusLabel.textContent = "Connecting";
  const socket = new WebSocket(socketUrl());
  state.socket = socket;
  state.socketReady = false;

  socket.addEventListener("open", () => {
    statusLabel.textContent = `Room ${state.roomId}`;
  });

  socket.addEventListener("message", (event) => {
    handleSocketMessage(event.data);
  });

  socket.addEventListener("close", () => {
    if (state.socket === socket) {
      state.socket = null;
      state.socketReady = false;
      state.connected = false;
      statusLabel.textContent = "Reconnecting";
      scheduleReconnect();
    }
  });

  socket.addEventListener("error", () => {
    statusLabel.textContent = "Connection error";
  });
}

function renderSpeciesCards(force = false) {
  if (!state.species.length) {
    return;
  }

  const renderKey = JSON.stringify({
    pearls: state.profile.pearls,
    selectedSpecies: state.profile.selectedSpecies,
    selectedVariants: state.profile.selectedVariants,
    upgrades: state.profile.upgrades,
    unlockedSpecies: state.profile.unlockedSpecies,
    ownedVariants: state.profile.ownedVariants
  });

  if (!force && renderKey === state.speciesRenderKey) {
    return;
  }

  state.speciesRenderKey = renderKey;
  speciesGrid.innerHTML = "";
  drawerPearlsLabel.textContent = String(state.profile.pearls);
  drawerRoomLabel.textContent = state.roomId || "solo";

  for (const species of state.species) {
    const unlocked = state.profile.unlockedSpecies.includes(species.id);
    const selected = state.profile.selectedSpecies === species.id;
    const owned = state.profile.ownedVariants[species.id] || [species.variants[0].id];
    const selectedVariant = getSelectedVariant(species.id);
    const rarity = getRarity(selectedVariant.rarity);
    const currentLevel = getUpgradeLevel(species.id);
    const nextUpgradeCost = upgradeCost(species, currentLevel);
    const scoutCost = variantDiscoveryCost(species);
    const lockedVariantsLeft = species.variants.some((variant) => !owned.includes(variant.id));

    const card = document.createElement("article");
    card.className = `species-card${!unlocked ? " locked" : ""}${selected ? " selected" : ""}`;

    const variantButtons = owned
      .map((variantId) => {
        const variant = species.variants.find((entry) => entry.id === variantId);
        if (!variant) {
          return "";
        }
        return `<button class="variant-chip${selectedVariant.id === variant.id ? " selected" : ""}" type="button" data-action="variant" data-species="${species.id}" data-variant="${variant.id}">
          <span style="background:${variant.color}"></span>${variant.label}
        </button>`;
      })
      .join("");

    card.innerHTML = `
      <div class="card-header">
        <strong><span class="species-swatch" style="background:${selectedVariant.color}; color:${selectedVariant.color}"></span>${species.label}</strong>
        <span class="variant-badge ${rarity.id}">${rarity.label}</span>
      </div>
      <div class="card-meta">
        <span>Owned ${owned.length}/${species.variants.length}</span>
        <span>Upgrade Lv.${currentLevel}/${state.maxUpgradeLevel}</span>
      </div>
      <div class="card-actions">
        <button type="button" data-action="species" data-species="${species.id}" ${!unlocked ? "disabled" : ""}>${selected ? "Swimming" : unlocked ? "Swim As" : `Need ${species.unlockScore}`}</button>
        <button type="button" data-action="upgrade" data-species="${species.id}" ${!unlocked || currentLevel >= state.maxUpgradeLevel || state.profile.pearls < nextUpgradeCost ? "disabled" : ""}>Upgrade ${currentLevel < state.maxUpgradeLevel ? `(${nextUpgradeCost})` : "(Max)"}</button>
        <button type="button" data-action="scout" data-species="${species.id}" ${!unlocked || !lockedVariantsLeft || state.profile.pearls < scoutCost ? "disabled" : ""}>Scout Variant ${lockedVariantsLeft ? `(${scoutCost})` : "(Done)"}</button>
      </div>
      <div class="variant-list">${variantButtons}</div>
    `;

    speciesGrid.appendChild(card);
  }

  speciesGrid.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const speciesId = button.dataset.species;
      const species = getSpecies(speciesId);
      const action = button.dataset.action;

      if (action === "species") {
        if (!state.profile.unlockedSpecies.includes(speciesId)) {
          return;
        }
        await profileAction("selectSpecies", speciesId, getSelectedVariant(speciesId).id);
        setUnlockPanelOpen(false);
        return;
      }

      if (action === "variant") {
        const variantId = button.dataset.variant;
        if (!(state.profile.ownedVariants[speciesId] || []).includes(variantId)) {
          return;
        }
        await profileAction("selectVariant", speciesId, variantId);
        return;
      }

      if (action === "upgrade") {
        const currentLevel = getUpgradeLevel(speciesId);
        const cost = upgradeCost(species, currentLevel);
        if (currentLevel >= state.maxUpgradeLevel || state.profile.pearls < cost) {
          return;
        }
        await profileAction("upgradeSpecies", speciesId);
        return;
      }

      if (action === "scout") {
        const cost = variantDiscoveryCost(species);
        if (state.profile.pearls < cost) {
          return;
        }
        await profileAction("scoutVariant", speciesId);
      }
    });
  });
}

async function connect(name, roomId) {
  const loadout = currentLoadout();
  const payload = await request("/api/join", {
    method: "POST",
    body: JSON.stringify({
      token: state.token,
      name,
      roomId,
      ...loadout
    })
  });

  state.token = payload.token;
  state.roomId = payload.roomId;
  state.species = payload.species;
  state.rarities = payload.rarities;
  state.maxUpgradeLevel = payload.maxUpgradeLevel;

  localStorage.setItem("grow-token", state.token);
  applyProfile(payload.profile);
  await migrateLegacyProfileIfNeeded();

  joinPanel.classList.add("hidden");
  hudPanel.classList.remove("hidden");
  unlockPanel.classList.remove("hidden");
  unlockToggle.classList.remove("hidden");

  updateShareLink(state.roomId, payload.shareUrl);
  renderSpeciesCards(true);
  setUnlockPanelOpen(window.innerWidth > 980);
  openSocket();
  showToast("Joined the room.");
}

function updateHud() {
  const self = state.snapshot?.self;
  pearlsLabel.textContent = String(state.profile.pearls);
  bestLabel.textContent = String(state.profile.bestScore);
  drawerPearlsLabel.textContent = String(state.profile.pearls);
  drawerRoomLabel.textContent = state.roomId || "solo";
  if (!self) {
    return;
  }

  speciesLabel.textContent = getSpecies(self.speciesId).label;
  massLabel.textContent = String(Math.round(self.mass));
  streakLabel.textContent = String(self.streak);
  statusLabel.textContent = self.alive ? `Room ${state.roomId} - ${state.snapshot.roomPopulation} online` : "Respawning";

  leaderboardList.innerHTML = "";
  for (const entry of state.snapshot.leaderboard || []) {
    const item = document.createElement("li");
    const rarity = getRarity(entry.rarity);
    item.innerHTML = `<span>${entry.name} <small style="color:${rarity.ring}">${rarity.label}</small></span><strong>${entry.score}</strong>`;
    leaderboardList.appendChild(item);
  }
}

function currentInput() {
  let x = 0;
  let y = 0;

  if (state.keys.has("KeyA")) x -= 1;
  if (state.keys.has("KeyD")) x += 1;
  if (state.keys.has("KeyW")) y -= 1;
  if (state.keys.has("KeyS")) y += 1;

  if (x === 0 && y === 0 && state.pointer.active) {
    x = state.pointer.x - window.innerWidth / 2;
    y = state.pointer.y - window.innerHeight / 2;
  }

  const length = Math.hypot(x, y) || 1;
  return {
    x: Math.abs(x) < 10 ? 0 : x / length,
    y: Math.abs(y) < 10 ? 0 : y / length,
    boost: state.keys.has("Space") || state.keys.has("ShiftLeft") || state.keys.has("ShiftRight")
  };
}

function sendInput(force = false) {
  if (!state.socketReady) {
    return;
  }

  const input = currentInput();
  const inputKey = `${input.x.toFixed(3)}:${input.y.toFixed(3)}:${input.boost ? 1 : 0}`;
  if (!force && inputKey === state.lastInputKey) {
    return;
  }

  state.lastInputKey = inputKey;
  sendSocket({
    type: "input",
    x: input.x,
    y: input.y,
    boost: input.boost
  });
}

function drawBackground() {
  const gradient = ctx.createLinearGradient(0, 0, 0, window.innerHeight);
  gradient.addColorStop(0, "#4ab5d6");
  gradient.addColorStop(0.35, "#17527e");
  gradient.addColorStop(1, "#041528");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  const grid = 170 * state.camera.zoom;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  const offsetX = (-state.camera.x * state.camera.zoom) % grid;
  const offsetY = (-state.camera.y * state.camera.zoom) % grid;
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

function worldToScreen(x, y) {
  return {
    x: (x - state.camera.x) * state.camera.zoom + window.innerWidth / 2,
    y: (y - state.camera.y) * state.camera.zoom + window.innerHeight / 2
  };
}

function drawFood(food) {
  const point = worldToScreen(food.x, food.y);
  const radius = food.radius * state.camera.zoom;
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

function drawFish(entity, isSelf = false) {
  const species = getSpecies(entity.speciesId);
  const point = worldToScreen(entity.x, entity.y);
  const radius = entity.radius * state.camera.zoom;
  if (point.x < -radius * 2 || point.y < -radius * 2 || point.x > window.innerWidth + radius * 2 || point.y > window.innerHeight + radius * 2) {
    return;
  }

  const angle = Math.atan2(entity.vy || 0.0001, entity.vx || 1);
  const bodyColor = entity.color || species.color;
  const accentColor = entity.accent || species.accent;
  const rarity = getRarity(entity.rarity || "common");

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);

  const bodyGradient = ctx.createLinearGradient(-radius, 0, radius, 0);
  bodyGradient.addColorStop(0, accentColor);
  bodyGradient.addColorStop(1, bodyColor);

  ctx.fillStyle = bodyGradient;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 1.2, radius * 0.78, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.moveTo(-radius * 1.15, 0);
  ctx.lineTo(-radius * 1.9, radius * 0.72);
  ctx.lineTo(-radius * 1.9, -radius * 0.72);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = rarity.ring;
  ctx.lineWidth = isSelf ? 2.5 : 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 1.3, radius * 0.9, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(radius * 0.4, -radius * 0.12, Math.max(3, radius * 0.12), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#072239";
  ctx.beginPath();
  ctx.arc(radius * 0.42, -radius * 0.12, Math.max(1.5, radius * 0.05), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  ctx.fillStyle = "rgba(240, 250, 255, 0.95)";
  ctx.font = '600 13px "Bahnschrift", "Trebuchet MS", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(entity.name, point.x, point.y - radius - 14);
}

function drawBounds() {
  const topLeft = worldToScreen(0, 0);
  const bottomRight = worldToScreen(state.config.world.width, state.config.world.height);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 4;
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.restore();
}

function drawOverlay(self) {
  if (!self || self.alive) {
    return;
  }

  const seconds = Math.max(0, Math.ceil((self.respawnAt - Date.now()) / 1000));
  ctx.save();
  ctx.fillStyle = "rgba(3, 8, 18, 0.42)";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.fillStyle = "#eef8ff";
  ctx.textAlign = "center";
  ctx.font = '700 36px "Impact", "Haettenschweiler", "Arial Narrow Bold", sans-serif';
  ctx.fillText("You got eaten", window.innerWidth / 2, window.innerHeight / 2 - 12);
  ctx.font = '500 18px "Bahnschrift", "Trebuchet MS", sans-serif';
  ctx.fillText(`Defeated by ${self.defeatedBy || "a larger fish"} - respawn in ${seconds}s`, window.innerWidth / 2, window.innerHeight / 2 + 22);
  ctx.restore();
}

function renderFrame(now) {
  const dt = Math.min(0.05, (now - state.lastFrame) / 1000);
  state.lastFrame = now;

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawBackground();

  if (state.snapshot?.self) {
    const self = state.snapshot.self;
    const targetZoom = Math.max(0.33, Math.min(0.9, 1.15 - self.radius / 160));
    state.camera.x += (self.x - state.camera.x) * Math.min(1, dt * 6);
    state.camera.y += (self.y - state.camera.y) * Math.min(1, dt * 6);
    state.camera.zoom += (targetZoom - state.camera.zoom) * Math.min(1, dt * 4);

    drawBounds();
    for (const food of state.snapshot.foods) drawFood(food);
    for (const bot of state.snapshot.bots) drawFish(bot);
    for (const player of state.snapshot.players) drawFish(player);
    drawFish(self, true);
    drawOverlay(self);
  }

  requestAnimationFrame(renderFrame);
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim() || "Shoal Scout";
  const roomId = sanitizeRoomId(roomInput.value) || state.roomId || randomRoomId();
  roomInput.value = roomId;

  try {
    await connect(name, roomId);
  } catch (error) {
    showToast(error.message);
  }
});

unlockToggle.addEventListener("click", () => {
  setUnlockPanelOpen(!state.unlockPanelOpen);
});

closeUnlocksButton.addEventListener("click", () => {
  setUnlockPanelOpen(false);
});

copyInviteButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareInput.value);
    showToast("Invite link copied");
  } catch (error) {
    showToast("Could not copy link");
  }
});

canvas.addEventListener("mousemove", (event) => {
  state.pointer.x = event.clientX;
  state.pointer.y = event.clientY;
  state.pointer.active = true;
});

canvas.addEventListener("mouseleave", () => {
  state.pointer.active = false;
});

window.addEventListener("keydown", (event) => {
  if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code)) {
    state.keys.add(event.code);
    if (event.code === "Space") {
      event.preventDefault();
    }
  }
});

window.addEventListener("keyup", (event) => {
  state.keys.delete(event.code);
});

window.addEventListener("resize", () => {
  resize();
});

Promise.resolve()
  .then(loadConfig)
  .then(bootstrapProfile)
  .then(() => {
    renderSpeciesCards(true);
    if (state.roomId) {
      roomInput.value = state.roomId;
    }
  })
  .catch((error) => {
    showToast(error.message);
  })
  .finally(() => {
    resize();
    setUnlockPanelOpen(window.innerWidth > 980);
    setInterval(() => sendInput(false), 70);
    setInterval(() => {
      if (state.socketReady) {
        sendSocket({ type: "ping" });
      }
    }, 10000);
    requestAnimationFrame(renderFrame);
  });
