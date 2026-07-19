// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { addLog, completeQueueItem, connectEventStream, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, cardMarkup, normalizeSettings, rarityColor } = await import(`./render.js?v=${__v}`);

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
  // A Team-Kampf/tournament fight starting is a guaranteed signal the signup window is over -
  // force the countdown/participant box away right now instead of only trusting its own local
  // timer (which must independently reach the same conclusion from deadlineUtc; this is a second,
  // redundant path to the same outcome so the box can never linger visible into the fight itself).
  if (event.teamBattle) hideTeamKampfSignup();
  if (event.tournamentRound) hideTournamentSignup();
  // A test event always previews (so it can be checked before enabling); real events obey the
  // toggle. Real events are gated by the server-side queue (see runQueue's finally below) - if
  // the animation is off, the event is dropped here but must still be acked immediately,
  // otherwise the queue would sit out the full timeout waiting for an ack that never comes.
  if (event.test !== true && settings?.battleAnimation?.enabled !== true) {
    completeQueueItem(event.eventId);
    return;
  }
  queue.push(event);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const event = queue.shift();
    try {
      await playBattle(event);
    } finally {
      completeQueueItem(event.eventId);
    }
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

// Shows the tournament bracket-so-far before a tournament match plays: the whole tree so far,
// scaled down to fit the stage, then a zoom onto the match that's about to happen. Only present
// on tournament matches (event.bracket) - a normal 1v1 !battle challenge has no bracket and skips
// this entirely. The bracket data itself only ever reveals rounds up to and including the current
// one (see ResolveTournamentSignup server-side) - nothing here shows a future round's outcome.
async function playBracketTree(bracket) {
  const rounds = Array.isArray(bracket?.rounds) ? bracket.rounds : [];
  if (!rounds.length) return;
  const currentRoundIndex = bracket.currentRoundIndex ?? 0;
  const currentMatchIndex = bracket.currentMatchIndex ?? 0;

  const wrap = document.createElement("div");
  wrap.className = "bracket-tree-overlay";
  const tree = document.createElement("div");
  tree.className = "bracket-tree";
  wrap.append(tree);

  let currentBox = null;
  rounds.forEach((round, roundIdx) => {
    const col = document.createElement("div");
    col.className = "bracket-round";
    const heading = document.createElement("div");
    heading.className = "bracket-round-label";
    heading.textContent = round.label || "";
    col.append(heading);
    (round.matches || []).forEach((match, matchIdx) => {
      const box = document.createElement("div");
      const isCurrent = roundIdx === currentRoundIndex && matchIdx === currentMatchIndex;
      box.className = `bracket-match${isCurrent ? " is-current" : ""}`;
      const aWon = match.winner === "a";
      const bWon = match.winner === "b";
      const bSlot = match.bye
        ? `<div class="bracket-entrant is-bye">${settings?.language === "en" ? "Bye" : "Freilos"}</div>`
        : `<div class="bracket-entrant ${bWon ? "is-winner" : match.winner ? "is-loser" : ""}">${escapeForOverlay(match.b || "?")}</div>`;
      box.innerHTML = `
        <div class="bracket-entrant ${aWon ? "is-winner" : match.winner ? "is-loser" : ""}">${escapeForOverlay(match.a || "?")}</div>
        ${bSlot}
      `;
      col.append(box);
      if (isCurrent) currentBox = box;
    });
    tree.append(col);
  });
  stage.append(wrap);

  // Measure everything in ONE untransformed layout pass - the zoom step below computes a fresh
  // transform from these natural coordinates rather than compounding on top of the fit-scale
  // transform, which keeps the math correct regardless of how either scale/position turns out.
  // getBoundingClientRect() forces a synchronous layout on its own - deliberately NOT waiting on
  // requestAnimationFrame here, since rAF callbacks can be paused entirely while a page/tab is
  // not visible (confirmed via document.hidden while testing), which would stall this forever;
  // a real OBS/Meld browser source keeps rendering regardless, but there is no reason to depend
  // on the paint loop for a plain layout measurement anyway.
  const stageRect = stage.getBoundingClientRect();
  const treeRect = tree.getBoundingClientRect();
  const boxRect = currentBox ? currentBox.getBoundingClientRect() : null;
  const margin = 120;
  const fitScale = Math.min(1, (stageRect.width - margin) / treeRect.width, (stageRect.height - margin) / treeRect.height);
  const stageCenterX = stageRect.width / 2;
  const stageCenterY = stageRect.height / 2;

  function focusOn(scale, localX, localY, durationMs) {
    tree.style.transition = durationMs ? `transform ${durationMs}ms cubic-bezier(.3,.8,.3,1)` : "none";
    tree.style.transform = `translate(${stageCenterX - localX * scale}px, ${stageCenterY - localY * scale}px) scale(${scale})`;
  }

  tree.style.transformOrigin = "0 0";
  focusOn(fitScale, treeRect.width / 2, treeRect.height / 2, 0);
  await delay(rounds.length > 1 ? 2400 : 1700);

  // The "new branch forms" animation only makes sense once a whole round's fights are OVER and
  // two winners have actually merged into a new round - never before round 1 (nothing feeds into
  // it) and never mid-round (a round's matches don't depend on each other). Since this module's
  // queue plays every match of a round before any match of the next round starts, the right
  // moment is exactly "the first match of a new round" - at that point every match box in the
  // PREVIOUS round is a settled result, and each one's two entrants have just combined into one
  // box in the round now being shown. Animate that merge for every match of the previous round
  // at once, then continue to the zoom-to-current-match step below.
  if (currentMatchIndex === 0 && currentRoundIndex > 0) {
    const prevRoundCol = tree.children[currentRoundIndex - 1];
    const feederBoxes = prevRoundCol ? [...prevRoundCol.querySelectorAll(".bracket-match")] : [];
    feederBoxes.forEach((feederBox) => {
      const line = document.createElement("div");
      line.className = "bracket-advance-line";
      line.style.transitionDuration = "900ms";
      feederBox.append(line);
      // Force a layout flush so the width transition animates from 0 instead of jumping straight
      // to its end state (same synchronous-measurement reasoning as above - no rAF).
      void line.offsetWidth;
      line.classList.add("is-filling");
    });
    await delay(1100);
  }

  if (boxRect) {
    const localX = boxRect.left - treeRect.left + boxRect.width / 2;
    const localY = boxRect.top - treeRect.top + boxRect.height / 2;
    const zoomScale = Math.min(2.4, Math.max(1, fitScale * 2.6));
    focusOn(zoomScale, localX, localY, 900);
    await delay(900 + 1300);
  }

  wrap.classList.add("is-out");
  await delay(400);
  wrap.remove();
}

async function playBattle(event = {}) {
  if (event.bracket) await playBracketTree(event.bracket);
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
      // Team-Kampf attaches a per-matchup nameA/nameB (which specific community member is
      // currently fighting) since event.userA/userB are just the fixed streamer/"Community"
      // labels for the whole multi-matchup fight - falls back to those for a normal 1v1/tournament
      // duel, which never sets these fields.
      const nameA = matchup.nameA || event.userA;
      const nameB = matchup.nameB || event.userB;
      await playHpMatchup(arena, matchup, hitDuration, nameA, nameB, hpState);
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
  // Applied to the whole #battle-stage rather than the per-event .battle-scene/bracket-tree
  // elements: the bracket tree does its own fit/zoom math relative to #battle-stage's rect
  // directly, so transforming an intermediate wrapper would throw that math off. This does mean
  // the tournament signup countdown moves along with the battle position/scale setting too.
  applyOverlayLayout(stage, settings.overlayLayout?.battle, "battle");
}

// Shared avatar-chip markup for both the tournament and the Team-Kampf signup roster.
function signupAvatarHtml(name, avatarUrl) {
  const safeName = escapeForOverlay(name || "");
  const img = avatarUrl
    ? `<img class="signup-roster-avatar" src="${escapeForOverlay(avatarUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'signup-roster-avatar signup-roster-avatar-fallback',textContent:'?'}))">`
    : `<span class="signup-roster-avatar signup-roster-avatar-fallback">?</span>`;
  return `<div class="signup-roster-participant">${img}<span class="signup-roster-participant-name">${safeName}</span></div>`;
}

// Own countdown, outside the queue: this has no animation of its own and must never block the
// queue, so it lives outside enqueueBattle/runQueue entirely and just reacts to its own SSE event
// directly. A live-updating row of joined participants (avatar + name - see
// BroadcastTournamentSignupState, which re-sends this on every join, not just once at start) so
// viewers see who else has already signed up, same as the Team-Kampf roster below.
let signupCountdownTimer = null;
let signupCountdownEl = null;

function ensureSignupCountdownEl() {
  if (signupCountdownEl) return signupCountdownEl;
  signupCountdownEl = document.createElement("div");
  signupCountdownEl.className = "signup-roster";
  signupCountdownEl.hidden = true;
  stage.append(signupCountdownEl);
  return signupCountdownEl;
}

// Unconditional hide, independent of whatever the local countdown interval thinks the remaining
// time is - mirrors hideTeamKampfSignup below.
function hideTournamentSignup() {
  clearInterval(signupCountdownTimer);
  if (signupCountdownEl) signupCountdownEl.hidden = true;
}

function handleTournamentSignupEvent(event = {}) {
  const el = ensureSignupCountdownEl();
  if (!event.active || !event.deadlineUtc) {
    hideTournamentSignup();
    return;
  }
  const deadline = new Date(event.deadlineUtc).getTime();
  const label = settings?.language === "en" ? "Tournament signup" : "Turnier-Anmeldung";
  const participants = Array.isArray(event.participants) ? event.participants : [];
  const participantsHtml = participants.map((p) => signupAvatarHtml(p?.displayName, p?.avatarUrl)).join("");
  const participantsLabel = settings?.language === "en" ? "Joined" : "Angemeldet";
  // Rebuilding the whole innerHTML on every join (not just at signup start) is deliberate and
  // cheap here - this box has no ongoing CSS animation to interrupt, unlike the queued battle
  // scenes, so there's no continuity to preserve across rebuilds the way liveticker.js's
  // append-only conveyor has to.
  el.innerHTML = `
    <div class="signup-roster-title"></div>
    ${participants.length ? `
      <div class="signup-roster-participants-label">${participantsLabel} (${participants.length})</div>
      <div class="signup-roster-participants">${participantsHtml}</div>
    ` : ""}
  `;
  const titleEl = el.querySelector(".signup-roster-title");
  // A fresh interval per event is intentional: clearing+recreating on every join keeps exactly one
  // ticking interval alive at all times (never zero, never more than one), and since it always
  // reads the SAME deadline (see BroadcastTournamentSignupState - the deadline is never
  // recomputed), the displayed countdown itself never jumps or resets when someone joins.
  clearInterval(signupCountdownTimer);
  const tick = () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      hideTournamentSignup();
      return;
    }
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    el.hidden = false;
    if (titleEl) titleEl.textContent = `🏆 ${label}: ${minutes}:${String(seconds).padStart(2, "0")}`;
  };
  tick();
  signupCountdownTimer = setInterval(tick, 1000);
}

// Same pattern as the tournament roster above, plus a row of the streamer's revealed lineup
// (drawn up front by the server, see DrawTeamBattleStreamerLineup) so viewers also know what
// they're up against, not just who else has already joined.
let teamKampfCountdownTimer = null;
let teamKampfEl = null;

function ensureTeamKampfEl() {
  if (teamKampfEl) return teamKampfEl;
  teamKampfEl = document.createElement("div");
  teamKampfEl.className = "signup-roster";
  teamKampfEl.hidden = true;
  stage.append(teamKampfEl);
  return teamKampfEl;
}

// Unconditional hide, independent of whatever the local countdown interval thinks the remaining
// time is - called both by the countdown reaching zero AND (redundantly, see enqueueBattle) the
// instant the fight itself actually starts, so the box can never linger on screen past that point.
function hideTeamKampfSignup() {
  clearInterval(teamKampfCountdownTimer);
  if (teamKampfEl) teamKampfEl.hidden = true;
}

function handleTeamBattleSignupEvent(event = {}) {
  const el = ensureTeamKampfEl();
  if (!event.active || !event.deadlineUtc) {
    hideTeamKampfSignup();
    return;
  }
  const deadline = new Date(event.deadlineUtc).getTime();
  const label = settings?.language === "en" ? "Team battle signup" : "Team-Kampf-Anmeldung";
  // Face-down card backs, on purpose: viewers should see HOW MANY cards they need to beat, not
  // which ones or how rare they are (that would let the community pre-plan around a known weak
  // spot in the lineup). The server only sends a count (see BroadcastTeamBattleSignupState), not
  // the actual card identities, so there's nothing to reveal even by inspecting the raw event.
  const lineupCount = Math.max(0, Number(event.streamerLineupCount) || 0);
  const lineupHtml = Array.from({ length: lineupCount }, () => `<div class="signup-roster-lineup-card">${cardMarkup(null, { compact: true, hidden: true })}</div>`).join("");
  const participants = Array.isArray(event.participants) ? event.participants : [];
  const participantsHtml = participants.map((p) => signupAvatarHtml(p?.displayName, p?.avatarUrl)).join("");
  const participantsLabel = settings?.language === "en" ? "Joined" : "Angemeldet";
  // Rebuilding the whole innerHTML on every join (not just at signup start) is deliberate and
  // cheap here - this box has no ongoing CSS animation to interrupt, unlike the queued battle
  // scenes, so there's no continuity to preserve across rebuilds the way liveticker.js's
  // append-only conveyor has to.
  el.innerHTML = `
    <div class="signup-roster-title"></div>
    <div class="signup-roster-lineup">${lineupHtml}</div>
    ${participants.length ? `
      <div class="signup-roster-participants-label">${participantsLabel} (${participants.length})</div>
      <div class="signup-roster-participants">${participantsHtml}</div>
    ` : ""}
  `;
  const titleEl = el.querySelector(".signup-roster-title");
  // A fresh interval per event is intentional: clearing+recreating on every join keeps exactly one
  // ticking interval alive at all times (never zero, never more than one), and since it always
  // reads the SAME deadline (see BroadcastTeamBattleSignupState - the deadline is never
  // recomputed), the displayed countdown itself never jumps or resets when someone joins.
  clearInterval(teamKampfCountdownTimer);
  const tick = () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      hideTeamKampfSignup();
      return;
    }
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    el.hidden = false;
    if (titleEl) titleEl.textContent = `${label}: ${minutes}:${String(seconds).padStart(2, "0")}`;
  };
  tick();
  teamKampfCountdownTimer = setInterval(tick, 1000);
}

function bindServerEvents() {
  connectEventStream({
    battle: (event) => enqueueBattle(event),
    settings: () => loadSettings(),
    tournamentsignup: (event) => handleTournamentSignupEvent(event),
    teamkampfsignup: (event) => handleTeamBattleSignupEvent(event),
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
