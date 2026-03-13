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
const bestLabel = document.getElementById("bestLabel");
const streakLabel = document.getElementById("streakLabel");
const statusLabel = document.getElementById("statusLabel");
const toast = document.getElementById("toast");

const PROFILE_KEY = "grow-profile";

const state = {
  token: localStorage.getItem("grow-token") || "",
  roomId: new URLSearchParams(window.location.search).get("room") || "",
  snapshot: null,
  connected: false,
  config: null,
  species: [],
  profile: loadProfile(),
  pointer: { x: 0, y: 0, active: false },
  keys: new Set(),
  camera: { x: 0, y: 0, zoom: 1 },
  lastFrame: performance.now(),
  pendingState: false,
  pendingInput: false,
  speciesRenderKey: "",
  toastTimer: null,
  unlockPanelOpen: window.innerWidth > 980
};

nameInput.value = state.profile.name;
roomInput.value = state.roomId;

function loadProfile() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || "");
    return {
      name: parsed.name || "",
      bestScore: parsed.bestScore || 0,
      unlockedSpecies: Array.isArray(parsed.unlockedSpecies) ? parsed.unlockedSpecies : ["sprout"],
      selectedSpecies: parsed.selectedSpecies || "sprout"
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
  localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile));
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

function getSpecies(speciesId) {
  return state.species.find((entry) => entry.id === speciesId) || state.species[0];
}

function updateShareLink(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  history.replaceState({}, "", `${url.pathname}?${url.searchParams.toString()}`);
  shareInput.value = url.toString();
}

async function loadConfig() {
  state.config = await request("/api/config");
  state.species = state.config.species;
}

function updateUnlockProgress() {
  const self = state.snapshot?.self;
  if (!self) {
    return;
  }

  const previousBest = state.profile.bestScore;
  const previousUnlocks = new Set(state.profile.unlockedSpecies);

  state.profile.bestScore = Math.max(state.profile.bestScore, self.bestScore || self.score || 0);

  for (const species of state.species) {
    if (state.profile.bestScore >= species.unlockScore && !state.profile.unlockedSpecies.includes(species.id)) {
      state.profile.unlockedSpecies.push(species.id);
    }
  }

  if (!state.profile.unlockedSpecies.includes(state.profile.selectedSpecies)) {
    state.profile.selectedSpecies = "sprout";
  }

  if (previousBest !== state.profile.bestScore || previousUnlocks.size !== state.profile.unlockedSpecies.length) {
    saveProfile();
    renderSpeciesCards(true);

    for (const speciesId of state.profile.unlockedSpecies) {
      if (!previousUnlocks.has(speciesId)) {
        showToast(`Unlocked ${getSpecies(speciesId).label}`);
      }
    }
  }
}

function renderSpeciesCards(force = false) {
  if (!state.species.length) {
    return;
  }

  const renderKey = JSON.stringify({
    selected: state.profile.selectedSpecies,
    unlocked: state.profile.unlockedSpecies
  });

  if (!force && renderKey === state.speciesRenderKey) {
    return;
  }

  state.speciesRenderKey = renderKey;
  speciesGrid.innerHTML = "";

  for (const species of state.species) {
    const locked = !state.profile.unlockedSpecies.includes(species.id);
    const selected = state.profile.selectedSpecies === species.id;
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
    button.addEventListener("click", async () => {
      const speciesId = button.dataset.species;
      if (!state.profile.unlockedSpecies.includes(speciesId)) {
        return;
      }

      state.profile.selectedSpecies = speciesId;
      saveProfile();
      renderSpeciesCards(true);
      setUnlockPanelOpen(false);

      if (state.connected) {
        try {
          await request("/api/select-species", {
            method: "POST",
            body: JSON.stringify({ token: state.token, speciesId })
          });
          if (state.snapshot?.self) {
            state.snapshot.self.speciesId = speciesId;
          }
          showToast(`${getSpecies(speciesId).label} selected`);
        } catch (error) {
          showToast(error.message);
        }
      }
    });
  });
}

async function connect(name, roomId) {
  const payload = await request("/api/join", {
    method: "POST",
    body: JSON.stringify({
      token: state.token,
      name,
      roomId,
      speciesId: state.profile.selectedSpecies
    })
  });

  state.token = payload.token;
  state.roomId = payload.roomId;
  state.connected = true;
  state.species = payload.species;

  localStorage.setItem("grow-token", state.token);
  state.profile.name = name;
  saveProfile();

  joinPanel.classList.add("hidden");
  hudPanel.classList.remove("hidden");
  unlockPanel.classList.remove("hidden");
  unlockToggle.classList.remove("hidden");

  updateShareLink(state.roomId);
  renderSpeciesCards(true);
  setUnlockPanelOpen(window.innerWidth > 980);
  showToast("Joined the room.");
}

function updateHud() {
  const self = state.snapshot?.self;
  if (!self) {
    return;
  }

  speciesLabel.textContent = getSpecies(self.speciesId).label;
  massLabel.textContent = String(Math.round(self.mass));
  bestLabel.textContent = String(state.profile.bestScore);
  streakLabel.textContent = String(self.streak);
  statusLabel.textContent = self.alive ? `Room ${state.roomId}` : "Respawning";

  leaderboardList.innerHTML = "";
  for (const entry of state.snapshot.leaderboard || []) {
    const item = document.createElement("li");
    item.innerHTML = `<span>${entry.name}</span><strong>${entry.score}</strong>`;
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

async function pollState() {
  if (!state.connected || state.pendingState) {
    return;
  }

  state.pendingState = true;
  try {
    state.snapshot = await request(`/api/state?token=${encodeURIComponent(state.token)}`);
    updateUnlockProgress();
    updateHud();
  } catch (error) {
    statusLabel.textContent = "Disconnected";
  } finally {
    state.pendingState = false;
  }
}

async function sendInput() {
  if (!state.connected || state.pendingInput) {
    return;
  }

  state.pendingInput = true;
  try {
    const input = currentInput();
    await request("/api/input", {
      method: "POST",
      body: JSON.stringify({
        token: state.token,
        x: input.x,
        y: input.y,
        boost: input.boost
      })
    });
  } catch (error) {
    statusLabel.textContent = "Connection lost";
  } finally {
    state.pendingInput = false;
  }
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
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);

  const bodyGradient = ctx.createLinearGradient(-radius, 0, radius, 0);
  bodyGradient.addColorStop(0, species.accent);
  bodyGradient.addColorStop(1, species.color);

  ctx.fillStyle = bodyGradient;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 1.2, radius * 0.78, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = species.color;
  ctx.beginPath();
  ctx.moveTo(-radius * 1.15, 0);
  ctx.lineTo(-radius * 1.9, radius * 0.72);
  ctx.lineTo(-radius * 1.9, -radius * 0.72);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(radius * 0.4, -radius * 0.12, Math.max(3, radius * 0.12), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#072239";
  ctx.beginPath();
  ctx.arc(radius * 0.42, -radius * 0.12, Math.max(1.5, radius * 0.05), 0, Math.PI * 2);
  ctx.fill();

  if (isSelf) {
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 1.34, radius * 0.92, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

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
  ctx.fillText(`Defeated by ${self.defeatedBy || "a larger fish"} • respawn in ${seconds}s`, window.innerWidth / 2, window.innerHeight / 2 + 22);
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
  if (window.innerWidth > 980 && !state.connected) {
    setUnlockPanelOpen(true);
  }
});

Promise.resolve()
  .then(loadConfig)
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
    setInterval(pollState, 120);
    setInterval(sendInput, 80);
    requestAnimationFrame(renderFrame);
  });
