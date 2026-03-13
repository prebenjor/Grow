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
const streakLabel = document.getElementById("streakLabel");
const statusLabel = document.getElementById("statusLabel");
const toast = document.getElementById("toast");

const state = {
  token: localStorage.getItem("ocean-rush-token") || "",
  name: localStorage.getItem("ocean-rush-name") || "",
  config: null,
  snapshot: null,
  connected: false,
  species: [],
  pointer: { x: 0, y: 0, active: false },
  keys: new Set(),
  lastFrame: performance.now(),
  camera: { x: 0, y: 0, zoom: 1 },
  selectedSpeciesId: "",
  toastTimer: null
};

nameInput.value = state.name;

function resize() {
  canvas.width = window.innerWidth * window.devicePixelRatio;
  canvas.height = window.innerHeight * window.devicePixelRatio;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

window.addEventListener("resize", resize);
resize();

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

async function loadConfig() {
  state.config = await request("/api/config");
  state.species = state.config.species;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2600);
}

function getSpecies(speciesId) {
  return state.species.find((entry) => entry.id === speciesId) || state.species[0];
}

function renderSpeciesCards() {
  if (!state.species.length) {
    return;
  }

  const unlocked = state.snapshot?.self?.unlockedSpecies || ["sprout"];
  const selectedId = state.snapshot?.self?.speciesId || state.selectedSpeciesId || "sprout";
  state.selectedSpeciesId = selectedId;

  speciesGrid.innerHTML = "";
  for (const species of state.species) {
    const card = document.createElement("article");
    const locked = !unlocked.includes(species.id);
    card.className = `species-card${locked ? " locked" : ""}${selectedId === species.id ? " selected" : ""}`;

    const canSelect = !locked;
    const buttonLabel = selectedId === species.id ? "Selected" : locked ? `Need ${species.unlockScore}` : "Switch";

    card.innerHTML = `
      <header>
        <strong><span class="species-swatch" style="background:${species.color}; color:${species.color}"></span>${species.label}</strong>
        <span>${locked ? "Locked" : "Ready"}</span>
      </header>
      <div class="species-meta">
        <span>Unlock score ${species.unlockScore}</span>
        <span>Speed ${Math.round(species.speed)}</span>
      </div>
      <button ${canSelect ? "" : "disabled"} data-species="${species.id}">${buttonLabel}</button>
    `;

    speciesGrid.appendChild(card);
  }

  speciesGrid.querySelectorAll("button[data-species]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const speciesId = button.dataset.species;
        await request("/api/select-species", {
          method: "POST",
          body: JSON.stringify({ token: state.token, speciesId })
        });
        state.selectedSpeciesId = speciesId;
        if (state.snapshot?.self) {
          state.snapshot.self.speciesId = speciesId;
        }
        renderSpeciesCards();
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}

function updateHud() {
  const self = state.snapshot?.self;
  if (!self) {
    return;
  }

  const species = getSpecies(self.speciesId);
  speciesLabel.textContent = species.label;
  massLabel.textContent = Math.round(self.mass);
  bestLabel.textContent = self.bestScore;
  streakLabel.textContent = self.streak;
  statusLabel.textContent = self.alive ? "Alive" : "Respawning";

  leaderboardList.innerHTML = "";
  for (const entry of state.snapshot.leaderboard) {
    const item = document.createElement("li");
    item.innerHTML = `<span>${entry.name}</span><strong>${entry.score}</strong>`;
    leaderboardList.appendChild(item);
  }

  if (!leaderboardList.children.length) {
    const item = document.createElement("li");
    item.innerHTML = `<span>No rivals yet</span><strong>0</strong>`;
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

async function connect(name) {
  const payload = await request("/api/join", {
    method: "POST",
    body: JSON.stringify({ token: state.token, name })
  });

  state.token = payload.token;
  state.species = payload.species;
  localStorage.setItem("ocean-rush-token", state.token);
  localStorage.setItem("ocean-rush-name", name);
  state.connected = true;

  joinPanel.classList.add("hidden");
  hudPanel.classList.remove("hidden");
  unlockPanel.classList.remove("hidden");
  showToast("You joined the ocean.");
  renderSpeciesCards();
}

async function pollState() {
  if (!state.connected || !state.token) {
    return;
  }

  try {
    const snapshot = await request(`/api/state?token=${encodeURIComponent(state.token)}`);
    const previousUnlocked = new Set(state.snapshot?.self?.unlockedSpecies || []);
    state.snapshot = snapshot;

    for (const speciesId of snapshot.self.justUnlocked) {
      const species = getSpecies(speciesId);
      showToast(`Unlocked ${species.label}`);
    }

    for (const speciesId of snapshot.self.unlockedSpecies) {
      if (!previousUnlocked.has(speciesId) && !snapshot.self.justUnlocked.includes(speciesId)) {
        const species = getSpecies(speciesId);
        showToast(`Unlocked ${species.label}`);
      }
    }

    updateHud();
    renderSpeciesCards();
  } catch (error) {
    statusLabel.textContent = "Disconnected";
  }
}

async function sendInput() {
  if (!state.connected || !state.token) {
    return;
  }

  const input = currentInput();
  try {
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
  }
}

function drawBackground(camera) {
  const gradient = ctx.createLinearGradient(0, 0, 0, window.innerHeight);
  gradient.addColorStop(0, "#4ab5d6");
  gradient.addColorStop(0.35, "#17527e");
  gradient.addColorStop(1, "#041528");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  const grid = 170 * camera.zoom;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;

  const offsetX = (-camera.x * camera.zoom) % grid;
  const offsetY = (-camera.y * camera.zoom) % grid;
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

function worldToScreen(x, y, camera) {
  return {
    x: (x - camera.x) * camera.zoom + window.innerWidth / 2,
    y: (y - camera.y) * camera.zoom + window.innerHeight / 2
  };
}

function drawFish(entity, camera, isSelf = false) {
  const species = getSpecies(entity.speciesId);
  const p = worldToScreen(entity.x, entity.y, camera);
  const radius = entity.radius * camera.zoom;
  const angle = Math.atan2(entity.vy || 0.0001, entity.vx || 1);

  ctx.save();
  ctx.translate(p.x, p.y);
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
  ctx.fillText(entity.name, p.x, p.y - radius - 14);
}

function drawFood(food, camera) {
  const p = worldToScreen(food.x, food.y, camera);
  const radius = food.radius * camera.zoom;
  const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 2.5);
  glow.addColorStop(0, food.color);
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius * 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = food.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawBounds(camera) {
  const topLeft = worldToScreen(0, 0, camera);
  const bottomRight = worldToScreen(state.config.world.width, state.config.world.height, camera);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 4;
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.restore();
}

function drawOverlay() {
  const self = state.snapshot?.self;
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
  drawBackground(state.camera);

  if (state.snapshot?.self) {
    const self = state.snapshot.self;
    const targetZoom = Math.max(0.33, Math.min(0.9, 1.15 - self.radius / 160));
    state.camera.x += (self.x - state.camera.x) * Math.min(1, dt * 6);
    state.camera.y += (self.y - state.camera.y) * Math.min(1, dt * 6);
    state.camera.zoom += (targetZoom - state.camera.zoom) * Math.min(1, dt * 4);

    drawBounds(state.camera);
    for (const food of state.snapshot.foods) drawFood(food, state.camera);
    for (const bot of state.snapshot.bots) drawFish(bot, state.camera);
    for (const player of state.snapshot.players) drawFish(player, state.camera);
    drawFish(self, state.camera, true);
    drawOverlay();
  }

  requestAnimationFrame(renderFrame);
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim() || "Shoal Scout";
  state.name = name;
  try {
    await connect(name);
  } catch (error) {
    showToast(error.message);
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

Promise.resolve()
  .then(loadConfig)
  .then(() => {
    if (state.name) {
      return connect(state.name);
    }
    return null;
  })
  .catch((error) => {
    showToast(error.message);
  })
  .finally(() => {
    setInterval(pollState, 120);
    setInterval(sendInput, 70);
    requestAnimationFrame(renderFrame);
  });
