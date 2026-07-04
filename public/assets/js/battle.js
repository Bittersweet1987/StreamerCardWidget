import { addLog, connectEventStream, getSettings } from "./api.js";
import { applyTheme, cardMarkup, normalizeSettings, rarityColor } from "./render.js";

const stage = document.querySelector("#battle-stage");
const status = document.querySelector("#status");

let settings;
let queue = [];
let running = false;
let audioContext;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DURATIONS = { short: 5000, medium: 8000, long: 12000 };
// HP-Leisten-Duell doesn't fit a fixed total budget the way clash/ranged rounds do: a fight can
// have anywhere from a handful of hits to several dozen (e.g. a common attacking a holo card),
// so each hit gets a fixed, readable duration instead of the total match being squeezed into
// the configured "Dauer" - the whole animation simply takes as long as the fight needs.
const HP_HIT_DURATIONS = { short: 450, medium: 650, long: 900 };

function setStatus(text, show = false) {
  status.textContent = text;
  status.hidden = !show;
}

function escapeForOverlay(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findCard(cardId) {
  return (settings.deck?.cards || []).find((card) => card.id === cardId) || null;
}

let battleAudioTemplate;
let battleAudioTemplateSrc;

function playBattleSound(kind) {
  const volume = Number(settings?.style?.volume || 0) / 100;
  if (volume <= 0) return;
  const uploaded = settings?.sounds?.battle;
  // Every cue (start/hit/win) uses the uploaded sound if one is set - not just "start" as
  // before. This also sidesteps browsers suspending a fresh AudioContext until a user gesture
  // (OBS/overlay pages never get one): a plain <audio> element plays regardless, so per-hit
  // sound reliably works once a battle sound file is set (which now ships as a default, see
  // sounds.battle in defaults/settings.json).
  if (uploaded) {
    // Decode the (base64) source once and clone per hit: hits can fire every ~220ms, and
    // re-parsing a data URL each time can lag behind and swallow individual hit sounds.
    if (battleAudioTemplateSrc !== uploaded) {
      battleAudioTemplate = new Audio(uploaded);
      battleAudioTemplate.preload = "auto";
      battleAudioTemplateSrc = uploaded;
    }
    const audio = battleAudioTemplate.cloneNode();
    audio.volume = Math.min(1, Math.max(0, volume * (kind === "hit" ? 0.7 : 1)));
    audio.play().catch((error) => {
      // Browsers block audio without a prior user gesture on this page (autoplay policy) -
      // this was previously swallowed silently, making it look like the sound was just missing.
      addLog("battle", "error", `Sound (${kind}) blockiert: ${error.name} ${error.message}`);
    });
    return;
  }
  if (audioContext && audioContext.state === "suspended") audioContext.resume().catch(() => {});
  audioContext ||= new AudioContext();
  const now = audioContext.currentTime;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime((kind === "win" ? 0.16 : 0.1) * volume, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  gain.connect(audioContext.destination);
  const freqs = kind === "win" ? [392, 523.25, 659.25, 784] : [220, 174.6];
  freqs.forEach((freq, index) => {
    const osc = audioContext.createOscillator();
    osc.type = kind === "win" ? "triangle" : "sawtooth";
    osc.frequency.setValueAtTime(freq, now + index * 0.07);
    osc.connect(gain);
    osc.start(now + index * 0.07);
    osc.stop(now + 0.5);
  });
}

function enqueueBattle(event = {}) {
  // A test event always previews (so it can be checked before enabling); real events obey the toggle.
  if (event.test !== true && settings?.battleAnimation?.enabled !== true) return;
  queue.push(event);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    await playBattle(queue.shift());
    await delay(400);
  }
  running = false;
}

function slotMarkup(card, side, label) {
  return `
    <div class="battle-slot slot-${side}">
      <div class="battle-anim">
        ${card ? cardMarkup(card) : ""}
        <span class="battle-name">${escapeForOverlay(label || "")}</span>
      </div>
    </div>
  `;
}

// Attacker = round winner (deals the hit), defender = round loser (reacts to it). The rarity
// of the attacking card colors the impact effect so legendary/holo attacks read as flashier.
function attackerDefender(round, cardA, cardB) {
  const attackerIsA = round.winner === "A";
  return {
    attackerCard: attackerIsA ? cardA : cardB,
    attackerSide: attackerIsA ? "a" : "b",
    defenderSide: attackerIsA ? "b" : "a"
  };
}

async function playClashRound(arena, round, cardA, cardB, roundDuration) {
  const { attackerCard, attackerSide, defenderSide } = attackerDefender(round, cardA, cardB);
  const attackerSlot = arena.querySelector(`.slot-${attackerSide}`);
  const defenderSlot = arena.querySelector(`.slot-${defenderSide}`);
  const color = rarityColor(attackerCard?.rarity);
  await delay(Math.round(roundDuration * 0.3));

  const lungeX = attackerSide === "a" ? "18vw" : "-18vw";
  attackerSlot?.animate(
    [{ transform: "translateX(0)" }, { transform: `translateX(${lungeX})` }, { transform: "translateX(0)" }],
    { duration: Math.round(roundDuration * 0.5), easing: "cubic-bezier(.4,0,.2,1)" }
  );

  await delay(Math.round(roundDuration * 0.22));
  const flash = document.createElement("div");
  flash.className = "battle-clash-flash";
  flash.style.setProperty("--hit-color", color);
  arena.append(flash);
  arena.animate(
    [{ transform: "translate(0,0)" }, { transform: "translate(-6px,3px)" }, { transform: "translate(6px,-3px)" }, { transform: "translate(0,0)" }],
    { duration: 260, easing: "ease-out" }
  );
  playBattleSound(round.suddenDeath ? "win" : "hit");
  defenderSlot?.classList.add("is-hit-flash");
  defenderSlot?.animate(
    [{ transform: "translate(0,0) rotate(0)" }, { transform: "translate(3vw,0) rotate(4deg)" }, { transform: "translate(0,0) rotate(0)" }],
    { duration: 320, easing: "ease-out" }
  );
  await delay(280);
  flash.remove();
  attackerSlot?.classList.add("is-round-winner");
  defenderSlot?.classList.add("is-round-loser");
  await delay(Math.max(0, roundDuration - Math.round(roundDuration * 0.3) - Math.round(roundDuration * 0.72) - 280));
}

async function playRangedRound(arena, round, cardA, cardB, roundDuration) {
  const { attackerCard, attackerSide, defenderSide } = attackerDefender(round, cardA, cardB);
  const attackerSlot = arena.querySelector(`.slot-${attackerSide}`);
  const defenderSlot = arena.querySelector(`.slot-${defenderSide}`);
  const color = rarityColor(attackerCard?.rarity);
  await delay(Math.round(roundDuration * 0.25));

  attackerSlot?.classList.add("is-charging");
  await delay(Math.round(roundDuration * 0.2));
  attackerSlot?.classList.remove("is-charging");

  if (attackerSlot && defenderSlot) {
    const arenaRect = arena.getBoundingClientRect();
    const fromRect = attackerSlot.getBoundingClientRect();
    const toRect = defenderSlot.getBoundingClientRect();
    const projectile = document.createElement("div");
    projectile.className = "battle-projectile";
    projectile.style.setProperty("--bolt-color", color);
    projectile.style.left = `${fromRect.left + fromRect.width / 2 - arenaRect.left}px`;
    projectile.style.top = `${fromRect.top + fromRect.height / 2 - arenaRect.top}px`;
    arena.append(projectile);
    const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
    const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
    const flightMs = Math.max(260, Math.round(roundDuration * 0.28));
    const anim = projectile.animate(
      [{ transform: "translate(-50%,-50%) scale(0.6)", opacity: 0 },
       { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.15 },
       { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1)`, opacity: 1 }],
      { duration: flightMs, easing: "cubic-bezier(.3,0,.7,1)" }
    );
    await anim.finished.catch(() => {});
    projectile.remove();
    const burst = document.createElement("div");
    burst.className = "battle-impact-burst";
    burst.style.setProperty("--hit-color", color);
    burst.style.left = `${toRect.left + toRect.width / 2 - arenaRect.left}px`;
    burst.style.top = `${toRect.top + toRect.height / 2 - arenaRect.top}px`;
    arena.append(burst);
    playBattleSound(round.suddenDeath ? "win" : "hit");
    defenderSlot.animate(
      [{ transform: "translate(0,0)" }, { transform: "translate(-1.5vw,0.5vw)" }, { transform: "translate(1.5vw,-0.5vw)" }, { transform: "translate(0,0)" }],
      { duration: 280, easing: "ease-out" }
    );
    await delay(300);
    burst.remove();
  }

  attackerSlot?.classList.add("is-round-winner");
  defenderSlot?.classList.add("is-round-loser");
  const spent = Math.round(roundDuration * 0.45) + 300;
  await delay(Math.max(0, roundDuration - spent));
}

// Plays one full matchup (a sequence of hits between the current fighter on each side) for the
// HP-Leisten-Duell style. The arena DOM is fully rebuilt at the start of EVERY matchup - both
// slots always get card artwork AND an HP bar, with widths computed from hpState (the remaining
// HP carried across matchups). Rebuilding from data each time is deliberately chosen over
// patching individual slots: earlier incremental variants repeatedly ended up with a slot
// missing its bar when an edge case (duplicate card ids, mid-animation reflow) was hit.
async function playHpMatchup(arena, matchup, hitDuration, userA, userB, hpState) {
  const cardA = findCard(matchup.cardA?.cardId);
  const cardB = findCard(matchup.cardB?.cardId);
  const maxHpA = Number(matchup.maxHpA) || 1;
  const maxHpB = Number(matchup.maxHpB) || 1;

  // A side gets a fresh card (full HP) whenever its card id changed vs. the previous matchup;
  // on the very first matchup both sides start fresh. The surviving side keeps hpState as-is.
  const newA = hpState.cardAId !== matchup.cardA?.cardId;
  const newB = hpState.cardBId !== matchup.cardB?.cardId;
  if (newA) hpState.hpA = maxHpA;
  if (newB) hpState.hpB = maxHpB;
  hpState.cardAId = matchup.cardA?.cardId;
  hpState.cardBId = matchup.cardB?.cardId;

  const pct = (hp, max) => `${Math.max(0, Math.min(100, (hp / max) * 100))}%`;
  arena.innerHTML = `
    <div class="battle-slot slot-a">
      <div class="battle-hp battle-hp-a"><div class="battle-hp-fill" style="width:${pct(hpState.hpA, maxHpA)}"></div></div>
      <div class="battle-anim">${cardA ? cardMarkup(cardA) : ""}<span class="battle-name">${escapeForOverlay(userA || "")}</span></div>
    </div>
    <div class="battle-slot slot-b">
      <div class="battle-hp battle-hp-b"><div class="battle-hp-fill" style="width:${pct(hpState.hpB, maxHpB)}"></div></div>
      <div class="battle-anim">${cardB ? cardMarkup(cardB) : ""}<span class="battle-name">${escapeForOverlay(userB || "")}</span></div>
    </div>
  `;
  const slotA = arena.querySelector(".slot-a");
  const slotB = arena.querySelector(".slot-b");
  if (newA) slotA?.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 300, easing: "ease-out" });
  if (newB) slotB?.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 300, easing: "ease-out" });
  await delay(newA || newB ? 320 : 120);

  const hits = Array.isArray(matchup.hits) ? matchup.hits : [];
  for (const hit of hits) {
    const attackerIsA = hit.attacker === "A";
    const attackerSlot = attackerIsA ? slotA : slotB;
    const defenderSlot = attackerIsA ? slotB : slotA;
    const defenderFill = defenderSlot?.querySelector(".battle-hp-fill");
    const defenderMax = attackerIsA ? maxHpB : maxHpA;
    const color = rarityColor((attackerIsA ? cardA : cardB)?.rarity);

    attackerSlot?.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.1)" }, { transform: "scale(1)" }],
      { duration: Math.round(hitDuration * 0.5), easing: "ease-out" }
    );
    await delay(Math.round(hitDuration * 0.35));
    playBattleSound("hit");
    defenderSlot?.classList.add("is-hit-flash");
    defenderSlot?.style.setProperty("--hit-color", color);
    const hpAfter = Math.max(0, Number(hit.hpAfter) || 0);
    if (attackerIsA) hpState.hpB = hpAfter; else hpState.hpA = hpAfter;
    if (defenderFill) defenderFill.style.width = pct(hpAfter, defenderMax);
    await delay(Math.round(hitDuration * 0.35));
    defenderSlot?.classList.remove("is-hit-flash");
    await delay(Math.max(0, hitDuration - Math.round(hitDuration * 0.7)));
  }

  const winnerIsA = matchup.winner === "A";
  (winnerIsA ? slotB : slotA)?.classList.add("is-round-loser");
  (winnerIsA ? slotA : slotB)?.classList.add("is-round-winner");
  playBattleSound("win");
  await delay(500);
}

async function playBattle(event = {}) {
  const isHpMode = event.mode === "hp";
  const rounds = Array.isArray(event.rounds) ? event.rounds : [];
  const matchups = Array.isArray(event.hpMatchups) ? event.hpMatchups : [];
  if (isHpMode ? !matchups.length : !rounds.length) return;

  const style = ["clash", "ranged", "hp"].includes(settings.battleAnimation?.style) ? settings.battleAnimation.style : "clash";
  const total = DURATIONS[settings.battleAnimation?.duration] || DURATIONS.medium;

  const scene = document.createElement("div");
  scene.className = `battle-scene style-${isHpMode ? "hp" : style}`;
  scene.style.setProperty("--dur", `${total}ms`);
  stage.append(scene);
  playBattleSound("start");
  addLog("battle", "info", `${event.userA} vs ${event.userB}: ${event.winsA ?? "?"}:${event.winsB ?? "?"}, Preis ${event.prizeCardTitle || event.prizeCardId || "?"}`);

  const header = document.createElement("div");
  header.className = "battle-header";
  header.innerHTML = `
    <span class="battle-title-a">${escapeForOverlay(event.userA || "")}</span>
    <span class="battle-vs">VS</span>
    <span class="battle-title-b">${escapeForOverlay(event.userB || "")}</span>
  `;
  scene.append(header);

  const arena = document.createElement("div");
  arena.className = "battle-arena";
  scene.append(arena);

  if (isHpMode) {
    let hitDuration = HP_HIT_DURATIONS[settings.battleAnimation?.duration] || HP_HIT_DURATIONS.medium;
    // Safety cap: a big strength mismatch (e.g. a common attacking a holo card) can rack up
    // dozens of hits. Speed hits up rather than let a single duel run for a minute+.
    const totalHits = matchups.reduce((sum, m) => sum + Math.max(1, m.hits?.length || 1), 0);
    const maxTotalMs = 28000;
    if (totalHits * hitDuration > maxTotalMs) hitDuration = Math.max(220, Math.floor(maxTotalMs / totalHits));
    // cardAId/cardBId start undefined so the first matchup counts both sides as fresh cards.
    const hpState = { hpA: 0, hpB: 0, cardAId: undefined, cardBId: undefined };
    for (const matchup of matchups) {
      await playHpMatchup(arena, matchup, hitDuration, event.userA, event.userB, hpState);
    }
  } else {
    const roundDuration = Math.max(900, Math.round(total * 0.7 / rounds.length));
    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i];
      const cardA = findCard(round.cardA?.cardId);
      const cardB = findCard(round.cardB?.cardId);
      arena.innerHTML = slotMarkup(cardA, "a", event.userA) + slotMarkup(cardB, "b", event.userB);
      if (style === "ranged") await playRangedRound(arena, round, cardA, cardB, roundDuration);
      else await playClashRound(arena, round, cardA, cardB, roundDuration);
    }
  }

  // Final result: winner highlighted, prize card "travels" to them.
  arena.innerHTML = "";
  const result = document.createElement("div");
  result.className = "battle-result";
  const prizeCard = findCard(event.prizeCardId);
  result.innerHTML = `
    <div class="battle-winner-name">${escapeForOverlay(event.winnerUser || "")} gewinnt!</div>
    <div class="battle-score">${event.winsA ?? 0} : ${event.winsB ?? 0}</div>
    ${prizeCard ? `<div class="battle-prize">${cardMarkup(prizeCard)}<span class="battle-prize-label">gewonnen von ${escapeForOverlay(event.loserUser || "")}</span></div>` : ""}
  `;
  arena.append(result);
  playBattleSound("win");
  await delay(2200);
  scene.remove();
}

async function loadSettings() {
  settings = normalizeSettings(await getSettings());
  applyTheme(settings);
}

function bindServerEvents() {
  connectEventStream({
    battle: (event) => enqueueBattle(event),
    settings: () => loadSettings(),
    collections: () => {},
    draw: () => {},
    trade: () => {},
    showcollection: () => {}
  });
}

function bindDebugHooks() {
  window.cardBattleAnimation = { play: enqueueBattle, reload: loadSettings };
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") === "1") {
    const cards = settings.deck?.cards || [];
    if (cards.length >= 2) {
      const wasEnabled = settings.battleAnimation?.enabled;
      settings.battleAnimation = settings.battleAnimation || {};
      settings.battleAnimation.enabled = true;
      setTimeout(() => {
        enqueueBattle({
          userA: params.get("a") || "UserA",
          userB: params.get("b") || "UserB",
          rounds: [{ cardA: { cardId: cards[0].id }, cardB: { cardId: cards[1].id }, winner: "A" }],
          winsA: 1, winsB: 0, winner: "A",
          winnerUser: params.get("a") || "UserA", loserUser: params.get("b") || "UserB",
          prizeCardId: cards[1].id, prizeCardTitle: cards[1].title
        });
        settings.battleAnimation.enabled = wasEnabled;
      }, 600);
    }
  }
}

// Chrome (and some CEF builds) block audio playback on a page until it has registered a user
// gesture. OBS browser sources and SSE-triggered playback never generate one on their own, so
// battle sounds could silently fail to play even with everything else configured correctly.
// Unlocking once on ANY interaction with this page (click/keydown - e.g. hovering the OBS
// preview in Studio Mode, or a manual test click) covers the common cases at no cost.
function unlockAudioOnce() {
  try {
    audioContext ||= new AudioContext();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  } catch {}
  const uploaded = settings?.sounds?.battle;
  if (uploaded) {
    const probe = new Audio(uploaded);
    probe.volume = 0;
    probe.play().then(() => probe.pause()).catch(() => {});
  }
}

function bindAudioUnlock() {
  const unlock = () => {
    unlockAudioOnce();
    window.removeEventListener("click", unlock);
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("pointerdown", unlock);
  };
  window.addEventListener("click", unlock);
  window.addEventListener("keydown", unlock);
  window.addEventListener("pointerdown", unlock);
}

async function init() {
  await loadSettings();
  bindServerEvents();
  bindDebugHooks();
  bindAudioUnlock();
}

init().catch((error) => setStatus(error.message, true));
