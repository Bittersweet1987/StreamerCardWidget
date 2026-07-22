// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { addLog, completeQueueItem, connectEventStream, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, cardMarkup, normalizeSettings, rarityColor } = await import(`./render.js?v=${__v}`);

const stage = document.querySelector("#battle-stage");
const status = document.querySelector("#status");
// Dedicated stages for the signup rosters (present in overlays.html) so they can be positioned/
// scaled independently of the Kampf-Animation. On the standalone battle.html test page these
// don't exist, so the signup boxes fall back into #battle-stage (no independent layout there).
const tournamentSignupStage = document.querySelector("#tournamentsignup-stage") || stage;
const teamKampfSignupStage = document.querySelector("#teamkampfsignup-stage") || stage;

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

// The champion's own bracket reveal (see playTournamentWon) has no duel of its own and the server
// never waits for an ack on it (EstimatedProcessingMs=200ms for "tournamentwon" - see the C#
// comment on that queue item), so it's pushed through this SAME client-side queue/runQueue as a
// normal battle event, just tagged, purely to stop it from visually overlapping the final match's
// still-playing duel animation - never to gate the server's own queue.
function enqueueTournamentWon(event = {}) {
  if (settings?.battleAnimation?.enabled !== true) return;
  queue.push({ ...event, __tournamentWon: true });
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const event = queue.shift();
    try {
      if (event.__tournamentWon) await playTournamentWon(event);
      else await playBattle(event);
    } finally {
      if (event.eventId) completeQueueItem(event.eventId);
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

// ---- Tournament bracket tree ----
// A single-elimination bracket's shape (how many rounds, how many match-boxes per round, and
// which box in an odd-sized round is a solo "bye") is fully determined by the participant count
// alone - nobody needs to have played yet to know the SKELETON, only to know who's actually IN
// each box. This lets the whole tree (including every future round, boxes shown as "?") render
// from the very first match onward, rather than only ever revealing "up to the current round"
// the way earlier versions of this overlay did.
const BRACKET_BOX_W = 220;
const BRACKET_BOX_H = 62;
const BRACKET_ROW_GAP = 26;
const BRACKET_COL_GAP = 96;
const BRACKET_LABEL_SPACE = 40;

// Mirrors ResolveTournamentSignup's own `while (round.Count > 1)` loop exactly (same halving,
// same odd-count bye, same round-label thresholds) so the labels/box-counts this produces for
// not-yet-reached rounds are byte-for-byte what the server will eventually send real data for.
function computeBracketSkeleton(totalParticipants) {
  const rounds = [];
  let count = Math.max(2, Math.floor(totalParticipants) || 2);
  let roundNumber = 1;
  while (count > 1) {
    const label = count <= 2 ? "Finale" : count <= 4 ? "Halbfinale" : `Runde ${roundNumber}`;
    const matchCount = Math.floor(count / 2);
    const hasBye = count % 2 === 1;
    const boxCount = matchCount + (hasBye ? 1 : 0);
    rounds.push({ label, boxCount, byeBoxIndex: hasBye ? boxCount - 1 : -1 });
    count = boxCount;
    roundNumber++;
  }
  return rounds;
}

// Y-center of round r+1 box k is the MIDPOINT of the two round-r boxes that feed it (2k and
// 2k+1) - the standard "elbow" bracket layout - or, if it has only one feeder (a bye advancing
// alone), simply that one feeder's own Y. Round 0 itself is just evenly spaced from the top.
function layoutBracketRounds(skeleton) {
  const yCenters = [];
  yCenters[0] = Array.from({ length: skeleton[0].boxCount }, (_, i) => i * (BRACKET_BOX_H + BRACKET_ROW_GAP) + BRACKET_BOX_H / 2);
  for (let r = 1; r < skeleton.length; r++) {
    const prev = yCenters[r - 1];
    const arr = [];
    for (let k = 0; k < skeleton[r].boxCount; k++) {
      const i0 = k * 2, i1 = k * 2 + 1;
      arr.push(i1 < prev.length ? (prev[i0] + prev[i1]) / 2 : prev[i0]);
    }
    yCenters[r] = arr;
  }
  return yCenters;
}

// A match/bye box counts as "already decided" for rendering purposes if the data says so, UNLESS
// it's the one single match this call is about to animate revealing (see findPreviousRealMatch) -
// that one renders as still-pending at first, then flips via revealMatch() a moment later.
function isFeederDecided(rounds, skeleton, revealTarget, r, idx) {
  if (revealTarget && revealTarget.r === r && revealTarget.m === idx) return false;
  if (skeleton[r]?.byeBoxIndex === idx) return true;
  return !!rounds[r]?.matches?.[idx]?.winner;
}

// Which single real match is "the one that just got decided" relative to the match/reveal about
// to play - i.e. the previous entry in strict queue order. Byes never get an animated reveal of
// their own (they're rendered as already-settled from the start, see buildBracketTreeDom), so
// this walks back over them to find the last REAL match.
function findPreviousRealMatch(skeleton, r, m) {
  if (m > 0) return { r, m: m - 1 };
  for (let rr = r - 1; rr >= 0; rr--) {
    const realCount = skeleton[rr].boxCount - (skeleton[rr].byeBoxIndex >= 0 ? 1 : 0);
    if (realCount > 0) return { r: rr, m: realCount - 1 };
  }
  return null;
}

function makeConnectorPiece(tree, x, y, hLen, decided, vLen) {
  const el = document.createElement("div");
  el.className = "bracket-connector" + (decided ? " is-decided" : "");
  if (vLen !== undefined) {
    el.style.left = `${x - 1.5}px`;
    el.style.top = `${y}px`;
    el.style.width = "3px";
    el.style.height = `${vLen}px`;
  } else {
    el.style.left = `${x}px`;
    el.style.top = `${y - 1.5}px`;
    el.style.width = `${hLen}px`;
    el.style.height = "3px";
  }
  tree.append(el);
  return el;
}

// Builds the full tree DOM (every round including ones the server hasn't resolved yet, shown as
// "?" boxes) plus the connector lines between every adjacent pair of rounds. Returns element
// references the caller needs afterward: to measure/zoom (boxEls), and to animate the reveal of
// one specific match a moment later (entrantEls/connectorPieces/nextEntrantEl).
function buildBracketTreeDom(skeleton, rounds, currentRoundIndex, currentMatchIndex, isChampionReveal, revealTarget, isFirstMatch) {
  const yCenters = layoutBracketRounds(skeleton);
  const wrap = document.createElement("div");
  wrap.className = "bracket-tree-overlay";
  const tree = document.createElement("div");
  tree.className = "bracket-tree";
  wrap.append(tree);

  const totalWidth = skeleton.length * BRACKET_BOX_W + (skeleton.length - 1) * BRACKET_COL_GAP;
  const totalHeight = BRACKET_LABEL_SPACE + Math.max(...yCenters[0]) + BRACKET_BOX_H / 2 + 20;
  tree.style.width = `${totalWidth}px`;
  tree.style.height = `${totalHeight}px`;

  const boxEls = [];
  const entrantEls = [];
  skeleton.forEach((roundMeta, r) => {
    const colX = r * (BRACKET_BOX_W + BRACKET_COL_GAP);
    const label = document.createElement("div");
    label.className = "bracket-round-label";
    label.style.left = `${colX}px`;
    label.style.width = `${BRACKET_BOX_W}px`;
    label.textContent = roundMeta.label;
    tree.append(label);

    boxEls[r] = [];
    entrantEls[r] = [];
    for (let k = 0; k < roundMeta.boxCount; k++) {
      const isByeBox = roundMeta.byeBoxIndex === k;
      const known = rounds[r]?.matches?.[k];
      const suppressNames = isFirstMatch && r === 0;
      const aName = suppressNames ? "?" : (known ? (known.a || "?") : "?");
      const bNameRaw = suppressNames ? null : (known ? known.b : null);

      const box = document.createElement("div");
      const isCurrent = !isChampionReveal && r === currentRoundIndex && k === currentMatchIndex;
      box.className = "bracket-match" + (isCurrent ? " is-current" : "");
      box.style.left = `${colX}px`;
      box.style.top = `${BRACKET_LABEL_SPACE + yCenters[r][k] - BRACKET_BOX_H / 2}px`;

      const aEl = document.createElement("div");
      aEl.className = "bracket-entrant" + (aName === "?" ? " is-unknown" : "");
      aEl.textContent = aName;
      box.append(aEl);

      const bEl = document.createElement("div");
      if (isByeBox) {
        bEl.className = "bracket-entrant is-bye";
        bEl.textContent = settings?.language === "en" ? "Bye" : "Freilos";
      } else {
        const bName = bNameRaw || "?";
        bEl.className = "bracket-entrant" + (bName === "?" ? " is-unknown" : "");
        bEl.textContent = bName;
      }
      box.append(bEl);

      const deferThis = revealTarget && revealTarget.r === r && revealTarget.m === k;
      if (known?.winner && !deferThis) {
        aEl.classList.toggle("is-winner", known.winner === "a");
        aEl.classList.toggle("is-loser", known.winner === "b");
        if (!isByeBox) {
          bEl.classList.toggle("is-winner", known.winner === "b");
          bEl.classList.toggle("is-loser", known.winner === "a");
        }
      } else if (isByeBox && !deferThis) {
        aEl.classList.add("is-winner");
      }

      tree.append(box);
      boxEls[r][k] = box;
      entrantEls[r][k] = { aEl, bEl };
    }
  });

  const connectorPieces = [];
  const nextEntrantEl = [];
  for (let r = 0; r < skeleton.length - 1; r++) {
    connectorPieces[r] = [];
    nextEntrantEl[r] = [];
    const prevCount = skeleton[r].boxCount;
    const colRight = r * (BRACKET_BOX_W + BRACKET_COL_GAP) + BRACKET_BOX_W;
    const trunkX = colRight + BRACKET_COL_GAP / 2;
    for (let k = 0; k < skeleton[r + 1].boxCount; k++) {
      const i0 = k * 2, i1 = k * 2 + 1;
      const nextIsBye = skeleton[r + 1].byeBoxIndex === k;
      if (i1 < prevCount) {
        const y0 = BRACKET_LABEL_SPACE + yCenters[r][i0];
        const y1 = BRACKET_LABEL_SPACE + yCenters[r][i1];
        const yOut = BRACKET_LABEL_SPACE + yCenters[r + 1][k];
        const decided0 = isFeederDecided(rounds, skeleton, revealTarget, r, i0);
        const decided1 = isFeederDecided(rounds, skeleton, revealTarget, r, i1);

        const hTop = makeConnectorPiece(tree, colRight, y0, BRACKET_COL_GAP / 2, decided0);
        const hBottom = makeConnectorPiece(tree, colRight, y1, BRACKET_COL_GAP / 2, decided1);
        const vTrunk = makeConnectorPiece(tree, trunkX, Math.min(y0, y1), undefined, decided0 && decided1, Math.abs(y1 - y0));
        const hOut = makeConnectorPiece(tree, trunkX, yOut, BRACKET_COL_GAP / 2, decided0 && decided1);

        connectorPieces[r][i0] = { hSelf: hTop, vTrunk, hOut, siblingAlreadyDecided: decided1 };
        connectorPieces[r][i1] = { hSelf: hBottom, vTrunk, hOut, siblingAlreadyDecided: decided0 };
        if (!nextIsBye) {
          nextEntrantEl[r][i0] = entrantEls[r + 1][k].aEl;
          nextEntrantEl[r][i1] = entrantEls[r + 1][k].bEl;
        }
      } else {
        // Solo pass-through (a bye advancing alone): one straight line, same Y on both sides.
        const y0 = BRACKET_LABEL_SPACE + yCenters[r][i0];
        const decided0 = isFeederDecided(rounds, skeleton, revealTarget, r, i0);
        const hFull = makeConnectorPiece(tree, colRight, y0, BRACKET_COL_GAP, decided0);
        connectorPieces[r][i0] = { hSelf: hFull, vTrunk: null, hOut: null, siblingAlreadyDecided: true };
        if (!nextIsBye) nextEntrantEl[r][i0] = entrantEls[r + 1][k].aEl;
      }
    }
  }

  return { wrap, tree, boxEls, entrantEls, connectorPieces, nextEntrantEl };
}

// Flips one already-decided match from "pending" to "revealed": colors the winner/loser, lights
// up its outgoing connector gold (the shared merge trunk only once BOTH its feeders are done),
// and writes the winner's name into whichever slot of the next round it feeds - the "branch turns
// gold and the name gets written into the next box" moment.
function revealMatch(r, m, rounds, skeleton, entrantEls, connectorPieces, nextEntrantEl) {
  const known = rounds[r]?.matches?.[m];
  if (!known?.winner) return;
  const isByeHere = skeleton[r].byeBoxIndex === m;
  const { aEl, bEl } = entrantEls[r][m];
  aEl.classList.toggle("is-winner", known.winner === "a");
  aEl.classList.toggle("is-loser", known.winner === "b");
  if (!isByeHere) {
    bEl.classList.toggle("is-winner", known.winner === "b");
    bEl.classList.toggle("is-loser", known.winner === "a");
  }
  const pieces = connectorPieces[r]?.[m];
  if (pieces) {
    pieces.hSelf?.classList.add("is-decided");
    if (pieces.siblingAlreadyDecided) {
      pieces.vTrunk?.classList.add("is-decided");
      pieces.hOut?.classList.add("is-decided");
    }
  }
  const target = nextEntrantEl[r]?.[m];
  if (target) {
    target.textContent = (known.winner === "a" ? known.a : known.b) || "?";
    target.classList.remove("is-unknown");
    target.classList.add("is-just-revealed");
  }
}

// The very first match of a tournament: round 1's names were deliberately rendered as "?" (see
// buildBracketTreeDom's suppressNames) so the tree first appears with everyone unknown, THEN
// fills in - rather than the real names just being there from the first frame.
function revealRoundZeroNames(entrantEls, rounds) {
  (entrantEls[0] || []).forEach(({ aEl, bEl }, idx) => {
    const known = rounds[0]?.matches?.[idx];
    if (!known) return;
    aEl.textContent = known.a || "?";
    aEl.classList.remove("is-unknown");
    aEl.classList.add("is-just-revealed");
    if (bEl.classList.contains("is-bye")) return;
    bEl.textContent = known.b || "?";
    bEl.classList.remove("is-unknown");
    bEl.classList.add("is-just-revealed");
  });
}

// Shows the tournament bracket before a tournament match plays: the WHOLE tree, every round
// (including ones not reached yet, as "?" placeholder boxes - see computeBracketSkeleton), fit to
// the stage. On the very first match, everyone starts unknown and round 1 fills in with names a
// moment later; on every later match, the previous match's branch is revealed (winner highlighted,
// connector turns gold, name written into the next box) before zooming into the upcoming match.
// Also handles the champion's own capstone reveal (bracket.isChampion) - the final branch lights
// up the same way, just with no further match to zoom into afterward.
async function playBracketTree(bracket) {
  const rounds = Array.isArray(bracket?.rounds) ? bracket.rounds : [];
  if (!rounds.length) return;
  const currentRoundIndex = bracket.currentRoundIndex ?? 0;
  const currentMatchIndex = bracket.currentMatchIndex ?? 0;
  const isChampionReveal = bracket.isChampion === true;
  const totalParticipants = Math.max(2, Number(bracket.totalParticipants) || (rounds[0]?.matches?.length || 1) * 2);
  const isFirstMatch = !isChampionReveal && currentRoundIndex === 0 && currentMatchIndex === 0;

  const skeleton = computeBracketSkeleton(totalParticipants);
  // Defensive only - a totalParticipants mismatch must never crash the overlay outright.
  while (skeleton.length < rounds.length) {
    const idx = skeleton.length;
    skeleton.push({ label: rounds[idx]?.label || "", boxCount: rounds[idx]?.matches?.length || 1, byeBoxIndex: -1 });
  }

  const revealTarget = isChampionReveal
    ? { r: currentRoundIndex, m: currentMatchIndex }
    : (isFirstMatch ? null : findPreviousRealMatch(skeleton, currentRoundIndex, currentMatchIndex));

  const { wrap, tree, boxEls, entrantEls, connectorPieces, nextEntrantEl } =
    buildBracketTreeDom(skeleton, rounds, currentRoundIndex, currentMatchIndex, isChampionReveal, revealTarget, isFirstMatch);
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
  // The current match box's rect is captured HERE, in the same untransformed pass as treeRect -
  // NOT after focusOn() has applied the fit transform. Measuring it later (against a treeRect from
  // before the transform) mixed two coordinate systems and made the zoom land off-center; keeping
  // both measurements in the same screen-space pass keeps the box-relative math self-consistent
  // regardless of any outer #battle-stage overlay-layout transform.
  const currentBox = !isChampionReveal ? boxEls[currentRoundIndex]?.[currentMatchIndex] : null;
  const currentBoxRect = currentBox ? currentBox.getBoundingClientRect() : null;
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

  if (isFirstMatch) {
    await delay(1600);
    revealRoundZeroNames(entrantEls, rounds);
    await delay(1200);
  } else {
    await delay(1300);
    if (revealTarget) {
      revealMatch(revealTarget.r, revealTarget.m, rounds, skeleton, entrantEls, connectorPieces, nextEntrantEl);
      await delay(1300);
    }
  }

  if (!isChampionReveal && currentBoxRect) {
    const localX = currentBoxRect.left - treeRect.left + currentBoxRect.width / 2;
    const localY = currentBoxRect.top - treeRect.top + currentBoxRect.height / 2;
    const zoomScale = Math.min(2.4, Math.max(1, fitScale * 2.6));
    focusOn(zoomScale, localX, localY, 900);
    await delay(900 + 1300);
  } else {
    await delay(600);
  }

  wrap.classList.add("is-out");
  await delay(400);
  wrap.remove();
}

// Champion capstone: the "tournamentwon" event has no duel of its own (see the C# comment on
// that queue item), so it broadcasts its own standalone bracket reveal instead of piggybacking on
// playBattle. Reuses the exact same renderer/reveal logic as every other round.
async function playTournamentWon(event = {}) {
  if (event.bracket) await playBracketTree(event.bracket);
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
  // Signup rosters are positioned/scaled on their OWN stages (see overlays.html) - only when those
  // dedicated stages actually exist. On battle.html they fall back to #battle-stage, which already
  // carries the battle layout above, so applying a second transform there would double up.
  if (tournamentSignupStage !== stage) applyOverlayLayout(tournamentSignupStage, settings.overlayLayout?.tournamentSignup, "tournamentSignup");
  if (teamKampfSignupStage !== stage) applyOverlayLayout(teamKampfSignupStage, settings.overlayLayout?.teamBattleSignup, "teamBattleSignup");
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
  tournamentSignupStage.append(signupCountdownEl);
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
  const joinLabel = settings?.language === "en" ? "Join with" : "Beitreten mit";
  const joinCommand = escapeForOverlay(event.joinCommand || "");
  // Rebuilding the whole innerHTML on every join (not just at signup start) is deliberate and
  // cheap here - this box has no ongoing CSS animation to interrupt, unlike the queued battle
  // scenes, so there's no continuity to preserve across rebuilds the way liveticker.js's
  // append-only conveyor has to.
  el.innerHTML = `
    <div class="signup-roster-title"></div>
    ${joinCommand ? `<div class="signup-roster-join-hint">${joinLabel}: <strong>${joinCommand}</strong></div>` : ""}
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
  teamKampfSignupStage.append(teamKampfEl);
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
  const joinLabel = settings?.language === "en" ? "Join with" : "Beitreten mit";
  const joinCommand = escapeForOverlay(event.joinCommand || "");
  // Rebuilding the whole innerHTML on every join (not just at signup start) is deliberate and
  // cheap here - this box has no ongoing CSS animation to interrupt, unlike the queued battle
  // scenes, so there's no continuity to preserve across rebuilds the way liveticker.js's
  // append-only conveyor has to.
  el.innerHTML = `
    <div class="signup-roster-title"></div>
    ${joinCommand ? `<div class="signup-roster-join-hint">${joinLabel}: <strong>${joinCommand}</strong></div>` : ""}
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
    tournamentwon: (event) => enqueueTournamentWon(event),
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
