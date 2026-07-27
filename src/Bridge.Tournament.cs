using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

namespace CardPackWidgetApp
{
    public sealed partial class TwitchBridge
    {
// True while a tournament OR Team-Kampf is either taking signups OR still playing out its
        // (front-loaded) matches in the action queue. A tournament resolves its WHOLE bracket
        // synchronously the instant signup closes and dumps every match at the FRONT of the queue
        // (see ResolveTournamentSignup/EnqueueBatchAtFront), so `activeTournament` goes null long
        // before those matches have finished animating - which is why checking the active-object
        // alone isn't enough: a Team-Kampf started during that playback would inject its own fight
        // right into the middle of the still-running bracket. Both start paths consult this so only
        // one big bracket event can be in flight (signup + playback) at a time. Cheap linear scan -
        // the queue is at most a few dozen items even for a large tournament.
        private bool IsBracketEventBusy()
        {
            lock (tournamentLock) { if (activeTournament != null) return true; }
            lock (teamBattleLock) { if (activeTeamBattle != null) return true; }
            return IsBracketPlaybackBusy();
        }

// Narrower than IsBracketEventBusy: true ONLY while a bracket's matches are actually being
        // played back in the queue (front-loaded there the instant signup closes - see
        // ResolveTournamentSignup/EnqueueBatchAtFront) - NOT during the signup window itself. Other
        // animations (draws, gifts, trades...) are only held back (see Enqueue/
        // FlushDeferredQueueIfIdle) once playback is actually under way; during signup they're
        // still allowed to play normally over the countdown.
        private bool IsBracketPlaybackBusy()
        {
            lock (queueLock)
            {
                if (currentQueueItem != null && IsBracketSource(GetString(currentQueueItem, "source", ""))) return true;
                foreach (Dictionary<string, object> queued in actionQueue)
                {
                    if (IsBracketSource(GetString(queued, "source", ""))) return true;
                }
            }
            return false;
        }

private static bool IsBracketSource(string source)
        {
            return source == "tournament" || source == "teamkampf";
        }

// ---- Tournament Mode ----
        //
        // One bracket at a time, global (like activeBattle). Flow: an admin/channel-point/chat
        // trigger opens a signup window (StartTournamentSignup); viewers join with a chat command
        // (JoinTournament) until the window closes; ResolveTournamentSignup then either cancels
        // (too few participants) or resolves the ENTIRE bracket synchronously (all rounds - match
        // resolution is instant dice-rolling, nothing to wait on) and feeds every match into the
        // existing serialized action queue as ordinary "battle" queue items, so they play out
        // through the normal battle animation one at a time, in bracket order, all by themselves -
        // exactly like the community-goal bonus draws pattern. Chat commentary for each match/bye/
        // the final winner is likewise NOT sent immediately during resolution (which would spam
        // every round's outcome into chat before the corresponding animation has even played and
        // spoil the final winner) - it is sent from ProcessQueueItem only once the queue actually
        // reaches that specific item, so commentary timing always tracks real animation playback.

        // Network I/O (chat messages, avatar lookups) must NEVER happen while tournamentLock is
        // held. ResolveTournamentSignup (fired by the signup timer) needs the very same lock to
        // start the bracket - if a join lands right as the timer elapses and that join is still
        // holding the lock through a slow/hung Twitch API call (WebClient has no explicit timeout,
        // so a stalled request can sit for up to 100s - see TwitchGet), the resolve is blocked
        // behind it, turning "timer ran out" into "wait minutes for a stuck HTTP request". Both
        // methods below only mutate state under the lock, then fire chat/broadcast calls
        // afterward with the lock already released - same fix applied to Team-Kampf.
        public string StartTournamentSignup(string login, string displayName, string source)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> tCfg = Obj(settings, "tournament");
            if (!GetBool(tCfg, "enabled", false)) return "disabled";
            // Versandart only applies to the chat-triggered path ("Turnier-Start (Chat)") - a
            // channel-points-started tournament has no outputMode concept of its own (see
            // StripDeckForRewardSave's rationale: Kanalpunkte only covers reward creation).
            Dictionary<string, object> tournamentStartCfg = source == "chat" ? Obj(Obj(settings, "chatCommands"), "tournamentStart") : null;

            // Only one bracket event (tournament OR Team-Kampf) may run at a time - a Team-Kampf
            // still playing out its matches would otherwise inject a fight into the middle of this
            // tournament's animations (and vice versa). See IsBracketEventBusy.
            if (IsBracketEventBusy())
            {
                SendCommandOutput(login, tournamentStartCfg, GetString(tCfg, "alreadyRunningMessage", DefaultTournamentAlreadyRunning)
                    .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                return "already_running";
            }

            bool alreadyRunning = false;
            string startMessage = null;
            string deadlineUtc = null;
            int minParticipantsForBroadcast = 0;
            string joinCommandText = null;

            lock (tournamentLock)
            {
                if (activeTournament != null)
                {
                    alreadyRunning = true;
                }
                else
                {
                    int minParticipants = Math.Max(2, GetInt(tCfg, "minParticipants", 3));
                    int signupSeconds = Math.Max(10, GetInt(tCfg, "signupSeconds", 90));
                    Dictionary<string, object> joinCfg = Obj(Obj(settings, "chatCommands"), "tournamentJoin");
                    joinCommandText = GetString(joinCfg, "prefix", "!") + GetString(joinCfg, "command", "turnier");
                    deadlineUtc = DateTime.UtcNow.AddSeconds(signupSeconds).ToString("o");

                    activeTournament = new Dictionary<string, object>
                    {
                        { "state", "signup" },
                        { "participants", new List<object>() },
                        { "minParticipants", minParticipants },
                        { "lineupSize", Math.Max(1, GetInt(tCfg, "lineupSize", 3)) },
                        { "winnerDraws", Math.Max(1, GetInt(tCfg, "winnerDraws", 1)) },
                        { "deadlineUtc", deadlineUtc },
                        { "startedAt", DateTime.UtcNow.ToString("o") },
                        { "joinCommand", joinCommandText }
                    };

                    startMessage = GetString(tCfg, "signupStartMessage", DefaultTournamentSignupStart)
                        .Replace("[Befehl]", joinCommandText)
                        .Replace("[Sekunden]", signupSeconds.ToString())
                        .Replace("[Mindestteilnehmer]", minParticipants.ToString());
                    minParticipantsForBroadcast = minParticipants;

                    if (tournamentSignupTimer != null) tournamentSignupTimer.Dispose();
                    tournamentSignupTimer = new System.Threading.Timer(delegate { ResolveTournamentSignup(); }, null, signupSeconds * 1000, System.Threading.Timeout.Infinite);
                    SavePendingState();
                }
            }

            if (alreadyRunning)
            {
                SendCommandOutput(login, tournamentStartCfg, GetString(tCfg, "alreadyRunningMessage", DefaultTournamentAlreadyRunning)
                    .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                return "already_running";
            }

            SendCommandOutput(login, tournamentStartCfg, startMessage);
            BroadcastTournamentSignupState(new List<object>(), deadlineUtc, minParticipantsForBroadcast, joinCommandText);

            // Whoever spent the channel points to start the tournament obviously wants to play in
            // it - join them automatically instead of making them also type the join command.
            // JoinTournament re-acquires tournamentLock, which is safe here (Monitor locks are
            // reentrant on the same thread) and still applies the normal eligibility check/message.
            if (source == "channelpoints" && !String.IsNullOrEmpty(login))
            {
                JoinTournament(login, displayName);
            }

            return "started";
        }

// settings: pass the already-loaded settings when the caller has them (ProcessChatMessage
        // does) to skip a redundant re-parse; null falls back to reading them here.
        private void JoinTournament(string login, string displayName, Dictionary<string, object> settingsIn = null)
        {
            string notEligibleMessage = null;
            string joinAckMessage = null;
            List<object> participantsSnapshot = null;
            string deadlineUtc = null;
            int minParticipantsForBroadcast = 0;
            string joinCommandText = null;
            Dictionary<string, object> joinCfg = null;

            lock (tournamentLock)
            {
                if (activeTournament == null || GetString(activeTournament, "state", "") != "signup") return;
                var participants = (List<object>)activeTournament["participants"];
                string loginKey = login.ToLowerInvariant();
                foreach (object p in participants)
                {
                    Dictionary<string, object> existing = p as Dictionary<string, object>;
                    if (existing != null && GetString(existing, "login", "") == loginKey) return;
                }

                Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
                Dictionary<string, object> tCfg = Obj(settings, "tournament");
                joinCfg = Obj(Obj(settings, "chatCommands"), "tournamentJoin");
                int lineupSize = GetInt(activeTournament, "lineupSize", 3);
                List<Dictionary<string, string>> owned = server.GetUserOwnedCardTypes(login);
                if (owned.Count < lineupSize)
                {
                    notEligibleMessage = GetString(tCfg, "notEligibleMessage", DefaultTournamentNotEligible)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Anzahl]", lineupSize.ToString());
                }
                else
                {
                    participants.Add(new Dictionary<string, object> { { "login", loginKey }, { "displayName", displayName } });
                    if (GetBool(tCfg, "announceJoins", true))
                    {
                        joinAckMessage = GetString(tCfg, "joinAckMessage", DefaultTournamentJoinAck)
                            .Replace("@userName", "@" + displayName)
                            .Replace("[Anzahl]", participants.Count.ToString());
                    }
                    // Snapshot (copy), not the live list reference - BroadcastTournamentSignupState
                    // runs after the lock is released, so it must never iterate the actual
                    // mutable list another thread could be adding to concurrently.
                    participantsSnapshot = new List<object>(participants);
                    deadlineUtc = GetString(activeTournament, "deadlineUtc", "");
                    minParticipantsForBroadcast = GetInt(activeTournament, "minParticipants", 3);
                    joinCommandText = GetString(activeTournament, "joinCommand", "");
                    SavePendingState();
                }
            }

            if (notEligibleMessage != null) { SendCommandOutput(login, joinCfg, notEligibleMessage); return; }
            if (joinAckMessage != null) SendCommandOutput(login, joinCfg, joinAckMessage);
            if (participantsSnapshot != null) BroadcastTournamentSignupState(participantsSnapshot, deadlineUtc, minParticipantsForBroadcast, joinCommandText);
        }

// Broadcasts a SNAPSHOT of the signup state (live participant list with avatars, deadline)
        // - called once at signup start and again after every successful join, so the overlay can
        // show who's already in without waiting for the bracket itself. Takes its data as
        // parameters rather than reading activeTournament directly, since callers now invoke this
        // AFTER releasing tournamentLock (see StartTournamentSignup/JoinTournament) - it must never
        // touch the live mutable state. Always resends the same deadlineUtc (never recomputed), so
        // the client's local countdown never jumps or restarts when a new participant joins
        // mid-countdown. Mirrors BroadcastTeamBattleSignupState - same roster box, same overlay
        // markup (see signup-roster in battle.css/js), just without a revealed lineup row (a
        // tournament bracket has nothing to reveal before it starts).
        private void BroadcastTournamentSignupState(List<object> participants, string deadlineUtc, int minParticipants, string joinCommand)
        {
            // Avatar lookups are one Twitch API call per not-yet-cached participant - routed
            // through the outbound queue so a join's chat processing never waits on them. FIFO
            // ordering in that queue guarantees roster updates still arrive oldest-to-newest.
            DispatchOutboundWork(delegate
            {
                var participantsForBroadcast = new object[participants.Count];
                for (int i = 0; i < participants.Count; i++)
                {
                    Dictionary<string, object> p = participants[i] as Dictionary<string, object>;
                    if (p == null) continue;
                    participantsForBroadcast[i] = new Dictionary<string, object>
                    {
                        { "login", GetString(p, "login", "") },
                        { "displayName", GetString(p, "displayName", "") },
                        { "avatarUrl", GetUserAvatarUrl(GetString(p, "login", "")) }
                    };
                }

                server.Broadcast("tournamentsignup", server.Serializer.Serialize(new Dictionary<string, object>
                {
                    { "active", true },
                    { "deadlineUtc", deadlineUtc },
                    { "minParticipants", minParticipants },
                    { "participants", participantsForBroadcast },
                    { "joinCommand", joinCommand ?? "" }
                }));
            });
        }

public Dictionary<string, object> GetTournamentState()
        {
            lock (tournamentLock)
            {
                if (activeTournament == null) return new Dictionary<string, object> { { "state", "idle" } };
                var participants = (List<object>)activeTournament["participants"];
                return new Dictionary<string, object>
                {
                    { "state", GetString(activeTournament, "state", "idle") },
                    { "participantCount", participants.Count },
                    { "minParticipants", GetInt(activeTournament, "minParticipants", 3) }
                };
            }
        }

// Resolves a single 1v1 tournament match (same weighted round/HP-elimination logic as a
        // normal !battle duel) with NO card transfer and NO battle-stats recording - tournament
        // matches only decide bracket advancement, per the "no cards at risk, winner gets pack
        // draws instead" design. Returns the same event shape battle.js already knows how to
        // animate (omitting the prizeCard* fields simply hides the prize line client-side).
        private Dictionary<string, object> ResolveTournamentDuel(
            string userA, List<Dictionary<string, string>> ownedA,
            string userB, List<Dictionary<string, string>> ownedB,
            int lineupSize, Dictionary<string, object> settings)
        {
            List<Dictionary<string, string>> lineupA = DrawRandomLineup(ownedA, lineupSize);
            List<Dictionary<string, string>> lineupB = DrawRandomLineup(ownedB, lineupSize);

            Dictionary<string, object> strengthCfg = Obj(settings, "battleStrength");
            double variance = GetDouble(strengthCfg, "variance", DefaultBattleVariance);
            Dictionary<string, object> battleAnimForStyle = Obj(settings, "battleAnimation");
            bool useHpElimination = GetString(battleAnimForStyle, "style", "clash") == "hp";

            int winsA = 0, winsB = 0;
            var rounds = new List<object>();
            Dictionary<string, object> hpResult = null;

            if (useHpElimination)
            {
                hpResult = ResolveHpElimination(lineupA, lineupB, strengthCfg, variance);
                winsA = GetInt(hpResult, "cardsLostB", 0);
                winsB = GetInt(hpResult, "cardsLostA", 0);
            }
            else
            {
                for (int i = 0; i < lineupSize; i++)
                {
                    bool aWins = RollRound(lineupA[i], lineupB[i], strengthCfg, variance);
                    if (aWins) winsA++; else winsB++;
                    rounds.Add(new Dictionary<string, object> { { "cardA", lineupA[i] }, { "cardB", lineupB[i] }, { "winner", aWins ? "A" : "B" } });
                }

                var usedIdsA = new HashSet<string>();
                foreach (Dictionary<string, string> c in lineupA) usedIdsA.Add(c["cardId"]);
                var usedIdsB = new HashSet<string>();
                foreach (Dictionary<string, string> c in lineupB) usedIdsB.Add(c["cardId"]);

                int suddenDeathRounds = 0;
                while (winsA == winsB && suddenDeathRounds < 20)
                {
                    List<Dictionary<string, string>> poolA = UnusedCardPool(ownedA, usedIdsA);
                    List<Dictionary<string, string>> poolB = UnusedCardPool(ownedB, usedIdsB);
                    List<Dictionary<string, string>> sdA = DrawRandomLineup(poolA, 1);
                    List<Dictionary<string, string>> sdB = DrawRandomLineup(poolB, 1);
                    usedIdsA.Add(sdA[0]["cardId"]);
                    usedIdsB.Add(sdB[0]["cardId"]);
                    bool aWins = RollRound(sdA[0], sdB[0], strengthCfg, variance);
                    if (aWins) winsA++; else winsB++;
                    rounds.Add(new Dictionary<string, object> { { "cardA", sdA[0] }, { "cardB", sdB[0] }, { "winner", aWins ? "A" : "B" }, { "suddenDeath", true } });
                    suddenDeathRounds++;
                }
            }

            bool winnerIsA = useHpElimination ? GetBool(hpResult, "winnerIsA", winsA >= winsB) : winsA > winsB;

            return new Dictionary<string, object>
            {
                { "userA", userA }, { "userB", userB },
                { "lineupA", lineupA }, { "lineupB", lineupB },
                { "mode", useHpElimination ? "hp" : "rounds" },
                { "rounds", rounds },
                { "hpMatchups", useHpElimination ? hpResult["matchups"] : new object[0] },
                { "winner", winnerIsA ? "A" : "B" },
                { "winsA", winsA }, { "winsB", winsB },
                { "winnerUser", winnerIsA ? userA : userB }, { "loserUser", winnerIsA ? userB : userA }
            };
        }

// ---- Team-Kampf ("Alle gegen den Streamer") ----
        //
        // One battle at a time, global (like activeTournament). Flow: a channel-points redemption
        // opens a signup window (StartTeamBattleSignup) and draws the streamer's lineup up front
        // (shown in the overlay immediately, so viewers know what they're up against); viewers
        // join with a chat command (JoinTeamBattle), each getting ONE random card from their own
        // collection assigned immediately (in signup order - first come, first in queue); when the
        // window closes, ResolveTeamBattleSignup resolves the WHOLE fight in one shot by handing
        // the streamer's lineup and the community's queue straight to the existing
        // ResolveHpElimination (the same HP-Leisten-Duell math a normal 1v1 !battle uses) - HP
        // already persists across matchups on BOTH sides there, which is exactly "next challenger
        // steps up once the current one is defeated", symmetric for the streamer's team too. The
        // whole multi-card fight is a SINGLE "battle" queue item (battle.js already loops every
        // hpMatchups entry in one event) - just with a per-matchup community member name attached
        // so the overlay shows who's currently fighting instead of a generic "Community" label.

        // Any booster (subOnly:null - no subExclusive filter) since the streamer's own lineup is
        // exempt from the normal "sub-exclusive boosters aren't reachable via packs" restriction.
        private List<Dictionary<string, string>> DrawTeamBattleStreamerLineup(int count)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            var lineup = new List<Dictionary<string, string>>();
            for (int i = 0; i < count; i++)
            {
                string boosterId = PickRandomBoosterId(null);
                if (String.IsNullOrWhiteSpace(boosterId)) continue;
                Dictionary<string, object> card = PickCardFromBooster(settings, boosterId);
                if (card == null) continue;
                Dictionary<string, object> booster = FindBooster(settings, boosterId);
                lineup.Add(new Dictionary<string, string>
                {
                    { "boosterId", boosterId },
                    { "cardId", GetString(card, "id", "") },
                    { "cardTitle", GetString(card, "title", "") },
                    { "boosterTitle", booster != null ? GetString(booster, "title", "") : "" },
                    { "rarity", GetString(card, "rarity", "common") }
                });
            }
            return lineup;
        }

// Network I/O (chat messages, avatar lookups) must NEVER happen while teamBattleLock is
        // held - see the identical comment on StartTournamentSignup for why: it can block
        // ResolveTeamBattleSignup (which needs the same lock) behind a slow/hung Twitch API call,
        // turning "timer ran out" into "wait minutes for a stuck HTTP request". Both methods below
        // only mutate state under the lock, then fire chat/broadcast calls afterward with the lock
        // already released.
        public string StartTeamBattleSignup(string login, string displayName, string source)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> tbCfg = Obj(settings, "teamBattle");
            if (!GetBool(tbCfg, "enabled", false)) return "disabled";
            // Versandart only applies to the chat-triggered path ("Team-Kampf-Start (Chat)") - a
            // channel-points-started Team-Kampf has no outputMode concept of its own.
            Dictionary<string, object> teamBattleStartCfg = source == "chat" ? Obj(Obj(settings, "chatCommands"), "teamBattleStart") : null;

            // Only one bracket event (tournament OR Team-Kampf) may run at a time - a tournament
            // still playing out its bracket would otherwise get this Team-Kampf injected into the
            // middle of its animations (and vice versa). See IsBracketEventBusy.
            if (IsBracketEventBusy())
            {
                bool teamBattleAlreadyActive;
                lock (teamBattleLock) { teamBattleAlreadyActive = activeTeamBattle != null; }
                if (teamBattleAlreadyActive)
                {
                    SendCommandOutput(login, teamBattleStartCfg, GetString(tbCfg, "busyMessage", DefaultTeamBattleBusy)
                        .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                    return "already_running";
                }
                // Blocked only by a TOURNAMENT (signup or still playing back its bracket), not by
                // another Team-Kampf - rather than rejecting the redemption/command outright, queue
                // it to auto-start for real the instant the tournament is completely done (see
                // ResolvePendingTeamBattleIfIdle, polled from QueueLoop) instead of silently
                // swallowing it.
                lock (pendingTeamBattleLock)
                {
                    pendingTeamBattleRequest = new Dictionary<string, object>
                    {
                        { "login", login }, { "displayName", displayName }, { "source", source }
                    };
                }
                SendCommandOutput(login, teamBattleStartCfg, GetString(tbCfg, "queuedMessage", DefaultTeamBattleQueued)
                    .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                return "queued";
            }

            bool alreadyRunning = false;
            bool noCards = false;
            string startMessage = null;
            List<Dictionary<string, string>> streamerLineupForBroadcast = null;
            string deadlineUtc = null;
            string joinCommandText = null;

            lock (teamBattleLock)
            {
                if (activeTeamBattle != null)
                {
                    alreadyRunning = true;
                }
                else
                {
                    // "Kartenanzahl Streamer-Team" is only the MINIMUM - the actual lineup size is
                    // randomized (min..min+4) so the streamer's side isn't the exact same size every
                    // single Team-Kampf. Safe to vary freely: ResolveHpElimination handles unequal
                    // streamer/community lineup lengths just fine (HP elimination, not paired rounds).
                    int streamerCardCountMin = Math.Max(1, GetInt(tbCfg, "streamerCardCount", 5));

                    // Difficulty rubber-banding: a persistent adjustment (see
                    // RecordTeamKampfDifficultyResult) grows the streamer's lineup size by one card
                    // per community win and shrinks it by one per loss, carried over indefinitely
                    // (no reset on a win) - floored so the fight can never drop below the
                    // configured minimum, and hard-floored at 1 either way (an opponent lineup of 0
                    // cards is never possible).
                    bool difficultyEnabled = GetBool(tbCfg, "difficultyRubberbandEnabled", true);
                    int streamerCardCount;
                    if (difficultyEnabled)
                    {
                        // Deterministic when the difficulty rubber-band is on: the whole point is
                        // that the community can SEE the lineup grow/shrink by exactly one card per
                        // result, which the min..min+4 random jitter below would otherwise mask
                        // (e.g. a loss shrinking the minimum from 3 to 2 could still roll a bigger
                        // actual lineup than the previous, undefeated-looking, win) - see the report
                        // that "the count still went up after a loss" this was fixed for.
                        int adjustment = server.GetTeamKampfDifficultyAdjustment();
                        int floorCount = Math.Max(1, GetInt(tbCfg, "difficultyMinCardCount", 1));
                        streamerCardCount = Math.Max(floorCount, streamerCardCountMin + adjustment);
                    }
                    else
                    {
                        lock (BattleRandom) { streamerCardCount = streamerCardCountMin + BattleRandom.Next(0, 5); }
                    }
                    int signupSeconds = Math.Max(10, GetInt(tbCfg, "signupSeconds", 60));
                    List<Dictionary<string, string>> streamerLineup = DrawTeamBattleStreamerLineup(streamerCardCount);
                    if (streamerLineup.Count == 0)
                    {
                        noCards = true;
                    }
                    else
                    {
                        Dictionary<string, object> joinCfg = Obj(Obj(settings, "chatCommands"), "teamBattleJoin");
                        joinCommandText = GetString(joinCfg, "prefix", "!") + GetString(joinCfg, "command", "teamkampf");
                        deadlineUtc = DateTime.UtcNow.AddSeconds(signupSeconds).ToString("o");

                        activeTeamBattle = new Dictionary<string, object>
                        {
                            { "state", "signup" },
                            { "participants", new List<object>() },
                            { "streamerLineup", streamerLineup },
                            { "deadlineUtc", deadlineUtc },
                            { "startedAt", DateTime.UtcNow.ToString("o") },
                            { "joinCommand", joinCommandText }
                        };

                        startMessage = GetString(tbCfg, "signupStartMessage", DefaultTeamBattleSignupStart)
                            .Replace("[Befehl]", joinCommandText)
                            .Replace("[Sekunden]", signupSeconds.ToString())
                            .Replace("[Anzahl]", streamerCardCount.ToString());
                        streamerLineupForBroadcast = streamerLineup;

                        if (teamBattleSignupTimer != null) teamBattleSignupTimer.Dispose();
                        teamBattleSignupTimer = new System.Threading.Timer(delegate { ResolveTeamBattleSignup(); }, null, signupSeconds * 1000, System.Threading.Timeout.Infinite);
                        SavePendingState();
                    }
                }
            }

            if (alreadyRunning)
            {
                SendCommandOutput(login, teamBattleStartCfg, GetString(tbCfg, "busyMessage", DefaultTeamBattleBusy)
                    .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                return "already_running";
            }
            if (noCards)
            {
                server.Log("battle", "error", "Team-Kampf konnte nicht gestartet werden: keine Karten verfuegbar.");
                return "no_cards";
            }

            SendCommandOutput(login, teamBattleStartCfg, startMessage);
            BroadcastTeamBattleSignupState(streamerLineupForBroadcast, new List<object>(), deadlineUtc, joinCommandText);

            // Whoever spent the channel points obviously wants their own card in the fight too.
            if (source == "channelpoints" && !String.IsNullOrEmpty(login))
            {
                JoinTeamBattle(login, displayName);
            }

            return "started";
        }

// Broadcasts a SNAPSHOT of the signup state (streamer lineup, live participant list with
        // avatars, deadline) - called once at signup start and again after every successful join,
        // so the overlay can show who's already in without waiting for the fight itself. Takes its
        // data as parameters rather than reading activeTeamBattle directly, since callers now
        // invoke this AFTER releasing teamBattleLock (see StartTeamBattleSignup/JoinTeamBattle) -
        // it must never touch the live mutable state. Always resends the same deadlineUtc (never
        // recomputed), so the client's local countdown never jumps or restarts when a new
        // participant joins mid-countdown.
        private void BroadcastTeamBattleSignupState(List<Dictionary<string, string>> streamerLineup, List<object> participants, string deadlineUtc, string joinCommand)
        {
            // Avatar lookups off the event worker - same reasoning as BroadcastTournamentSignupState.
            int streamerLineupCount = streamerLineup.Count;
            DispatchOutboundWork(delegate
            {
                var participantsForBroadcast = new object[participants.Count];
                for (int i = 0; i < participants.Count; i++)
                {
                    Dictionary<string, object> p = participants[i] as Dictionary<string, object>;
                    if (p == null) continue;
                    participantsForBroadcast[i] = new Dictionary<string, object>
                    {
                        { "login", GetString(p, "login", "") },
                        { "displayName", GetString(p, "displayName", "") },
                        { "avatarUrl", GetUserAvatarUrl(GetString(p, "login", "")) }
                    };
                }

                // Viewers should only ever learn HOW MANY cards they need to beat, never which ones or
                // how rare they are - sending only the count (not the card identities/rarities
                // themselves) keeps that true even for someone inspecting the raw SSE payload, not
                // just for what's rendered on screen (see cardMarkup(null, {hidden:true}) in battle.js).
                server.Broadcast("teamkampfsignup", server.Serializer.Serialize(new Dictionary<string, object>
                {
                    { "active", true },
                    { "deadlineUtc", deadlineUtc },
                    { "streamerLineupCount", streamerLineupCount },
                    { "participants", participantsForBroadcast },
                    { "joinCommand", joinCommand ?? "" }
                }));
            });
        }

// settingsIn: same pattern as JoinTournament - reuse the caller's already-loaded settings.
        private void JoinTeamBattle(string login, string displayName, Dictionary<string, object> settingsIn = null)
        {
            string noActiveMessage = null;
            string alreadyMessage = null;
            string notOwnedMessage = null;
            string successMessage = null;
            List<Dictionary<string, string>> streamerLineupForBroadcast = null;
            List<object> participantsSnapshot = null;
            string deadlineUtc = null;
            string joinCommandText = null;
            Dictionary<string, object> joinCfg = null;

            lock (teamBattleLock)
            {
                if (activeTeamBattle == null || GetString(activeTeamBattle, "state", "") != "signup")
                {
                    Dictionary<string, object> settingsIdle = settingsIn != null ? settingsIn : server.ReadSettingsObject();
                    Dictionary<string, object> tbCfgIdle = Obj(settingsIdle, "teamBattle");
                    joinCfg = Obj(Obj(settingsIdle, "chatCommands"), "teamBattleJoin");
                    noActiveMessage = GetString(tbCfgIdle, "noActiveMessage", DefaultTeamBattleNoActive).Replace("@userName", "@" + displayName);
                }
                else
                {
                    var participants = (List<object>)activeTeamBattle["participants"];
                    string loginKey = login.ToLowerInvariant();
                    Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
                    Dictionary<string, object> tbCfg = Obj(settings, "teamBattle");
                    joinCfg = Obj(Obj(settings, "chatCommands"), "teamBattleJoin");
                    bool alreadyIn = false;
                    foreach (object p in participants)
                    {
                        Dictionary<string, object> existing = p as Dictionary<string, object>;
                        if (existing != null && GetString(existing, "login", "") == loginKey) { alreadyIn = true; break; }
                    }

                    if (alreadyIn)
                    {
                        alreadyMessage = GetString(tbCfg, "joinAlreadyMessage", DefaultTeamBattleJoinAlready).Replace("@userName", "@" + displayName);
                    }
                    else
                    {
                        List<Dictionary<string, string>> owned = server.GetUserOwnedCardTypes(login);
                        if (owned.Count == 0)
                        {
                            notOwnedMessage = GetString(tbCfg, "joinNotOwnedMessage", DefaultTeamBattleJoinNotOwned).Replace("@userName", "@" + displayName);
                        }
                        else
                        {
                            Dictionary<string, string> card = DrawRandomLineup(owned, 1)[0];
                            participants.Add(new Dictionary<string, object>
                            {
                                { "login", loginKey }, { "displayName", displayName },
                                { "boosterId", card["boosterId"] }, { "cardId", card["cardId"] }
                            });

                            successMessage = GetString(tbCfg, "joinSuccessMessage", DefaultTeamBattleJoinSuccess)
                                .Replace("@userName", "@" + displayName)
                                .Replace("[Anzahl]", participants.Count.ToString());
                            streamerLineupForBroadcast = (List<Dictionary<string, string>>)activeTeamBattle["streamerLineup"];
                            // Snapshot (copy), not the live list reference - the broadcast runs
                            // after the lock is released, so it must never iterate the actual
                            // mutable list another thread could be adding to concurrently.
                            participantsSnapshot = new List<object>(participants);
                            deadlineUtc = GetString(activeTeamBattle, "deadlineUtc", "");
                            joinCommandText = GetString(activeTeamBattle, "joinCommand", "");
                            SavePendingState();
                        }
                    }
                }
            }

            if (noActiveMessage != null) { SendCommandOutput(login, joinCfg, noActiveMessage); return; }
            if (alreadyMessage != null) { SendCommandOutput(login, joinCfg, alreadyMessage); return; }
            if (notOwnedMessage != null) { SendCommandOutput(login, joinCfg, notOwnedMessage); return; }
            SendCommandOutput(login, joinCfg, successMessage);
            BroadcastTeamBattleSignupState(streamerLineupForBroadcast, participantsSnapshot, deadlineUtc, joinCommandText);
        }

// Timer callback once the signup window closes - runs off the chat/HTTP threads, so it is
        // free to resolve the whole fight synchronously (the HP-elimination math is instant dice
        // rolling, same as a normal 1v1 duel) before touching the queue.
        private void ResolveTeamBattleSignup()
        {
            List<Dictionary<string, object>> participants;
            List<Dictionary<string, string>> streamerLineup;
            lock (teamBattleLock)
            {
                if (activeTeamBattle == null) return;
                var rawParticipants = (List<object>)activeTeamBattle["participants"];
                participants = new List<Dictionary<string, object>>();
                foreach (object p in rawParticipants) if (p is Dictionary<string, object>) participants.Add((Dictionary<string, object>)p);
                streamerLineup = (List<Dictionary<string, string>>)activeTeamBattle["streamerLineup"];
                activeTeamBattle = null;
            }
            SavePendingState();

            server.Broadcast("teamkampfsignup", server.Serializer.Serialize(new Dictionary<string, object> { { "active", false } }));

            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> tbCfg = Obj(settings, "teamBattle");
            string streamerName = GetString(TwitchSettings(), "displayName", GetString(TwitchSettings(), "login", "Streamer"));

            if (participants.Count == 0)
            {
                SendChatMessageSafe(GetString(tbCfg, "noParticipantsMessage", DefaultTeamBattleNoParticipants).Replace("@streamerName", streamerName));
                return;
            }

            var communityLineup = new List<Dictionary<string, string>>();
            foreach (Dictionary<string, object> p in participants)
            {
                communityLineup.Add(new Dictionary<string, string> { { "boosterId", GetString(p, "boosterId", "") }, { "cardId", GetString(p, "cardId", "") } });
            }

            Dictionary<string, object> strengthCfg = Obj(settings, "battleStrength");
            double variance = GetDouble(strengthCfg, "variance", DefaultBattleVariance);
            Dictionary<string, object> hpResult = ResolveHpElimination(streamerLineup, communityLineup, strengthCfg, variance);
            object[] matchups = (object[])hpResult["matchups"];
            bool communityWon = !GetBool(hpResult, "winnerIsA", true);

            // Recorded HERE, synchronously, the instant the outcome is known - not later when the
            // "teamkampfresult" queue item is dequeued (see ProcessQueueItem). That item only runs
            // once the "battle" item ahead of it has been acked by the overlay (or timed out after
            // up to ~180s for a big fight - see EstimatedProcessingMs), so if a streamer starts the
            // next Team-Kampf again quickly, the adjustment from the PREVIOUS fight might still be
            // sitting unrecorded in the queue - the report that "a win/loss doesn't seem to change
            // the next fight's size" if you retry fast was exactly this delay, not the ±1 math
            // itself being wrong (see StartTeamBattleSignup).
            int difficultyStep = Math.Max(1, GetInt(tbCfg, "difficultyStepDown", 1));
            server.RecordTeamKampfDifficultyResult(communityWon, difficultyStep);

            // Walks the matchups in order, tracking which community-lineup slot ("B" side) is
            // fighting at each point, so the overlay can show that specific viewer's name instead
            // of a generic team label. bIndex only advances when B's card was the one eliminated
            // (winner == "A") - the same "next challenger steps up" logic ResolveHpElimination
            // itself uses internally, just re-derived here from its output.
            int bIndex = 0;
            string finisherLogin = null, finisherDisplayName = null;
            // Tallies, per participant, how many streamer cards THEY PERSONALLY defeated - a
            // participant whose card wins a round keeps fighting the streamer's next card (bIndex
            // doesn't advance), so a single participant can rack up several defeats in one Team-
            // Kampf even if their own card is eventually eliminated. Feeds the optional "per
            // defeated card" bonus draw below - independent of the overall win/loss, since an
            // individual can defeat cards even in a Team-Kampf the community ultimately loses.
            var defeatsByLogin = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < matchups.Length; i++)
            {
                Dictionary<string, object> matchup = (Dictionary<string, object>)matchups[i];
                Dictionary<string, object> participant = participants[Math.Min(bIndex, participants.Count - 1)];
                matchup["nameA"] = streamerName;
                matchup["nameB"] = GetString(participant, "displayName", "Viewer");
                string matchupWinner = GetString(matchup, "winner", "");
                if (matchupWinner == "B")
                {
                    string pLogin = GetString(participant, "login", "");
                    if (!String.IsNullOrEmpty(pLogin))
                    {
                        int existing;
                        defeatsByLogin[pLogin] = (defeatsByLogin.TryGetValue(pLogin, out existing) ? existing : 0) + 1;
                    }
                }
                if (i == matchups.Length - 1 && communityWon)
                {
                    finisherLogin = GetString(participant, "login", "");
                    finisherDisplayName = GetString(participant, "displayName", "Viewer");
                }
                if (matchupWinner == "A") bIndex++;
            }

            server.Log("battle", "info", streamerName + " (Team-Kampf) vs. " + participants.Count + " Zuschauer: " + (communityWon ? "Community gewinnt" : "Streamer gewinnt") + ".");

            var battleEvent = new Dictionary<string, object>
            {
                { "userA", streamerName }, { "userB", GetString(tbCfg, "communityLabel", "Community") },
                { "lineupA", streamerLineup }, { "lineupB", communityLineup },
                { "mode", "hp" }, { "rounds", new object[0] }, { "hpMatchups", matchups },
                { "winner", communityWon ? "B" : "A" },
                { "winsA", GetInt(hpResult, "cardsLostB", 0) }, { "winsB", GetInt(hpResult, "cardsLostA", 0) },
                { "winnerUser", communityWon ? "Community" : streamerName }, { "loserUser", communityWon ? streamerName : "Community" },
                { "teamBattle", true }
            };

            var defeatsForItem = new Dictionary<string, object>();
            foreach (KeyValuePair<string, int> kv in defeatsByLogin) defeatsForItem[kv.Key] = kv.Value;
            var resultExtra = new Dictionary<string, object>
            {
                { "communityWon", communityWon },
                { "participants", participants },
                { "finisherLogin", finisherLogin }, { "finisherDisplayName", finisherDisplayName },
                { "streamerName", streamerName },
                { "defeatsByLogin", defeatsForItem }
            };
            // Built and flushed as one atomic batch at the FRONT of the queue (see
            // EnqueueBatchAtFront) so the Team-Kampf starts the instant signup closes - ahead of
            // any pack draws already waiting - and nothing else can land between the fight
            // animation and its result/reward item.
            EnqueueBatchAtFront(new List<Dictionary<string, object>>
            {
                BuildQueueItem("battle", "", streamerName, "teamkampf", battleEvent),
                BuildQueueItem("teamkampfresult", "", streamerName, "teamkampf", resultExtra)
            });
        }

// Timer callback once the signup window closes. Runs entirely off the chat/HTTP threads,
        // so it is free to take its time resolving every round synchronously before touching the
        // queue - nothing here blocks command handling.
        private void ResolveTournamentSignup()
        {
            List<Dictionary<string, object>> participants;
            int minParticipants;
            int lineupSize;
            int winnerDraws;
            bool perRoundWinnerEnabled;
            bool championDrawsEnabled;
            Dictionary<string, object> tCfg;
            Dictionary<string, object> settings;

            lock (tournamentLock)
            {
                if (activeTournament == null) return;
                var rawParticipants = (List<object>)activeTournament["participants"];
                participants = new List<Dictionary<string, object>>();
                foreach (object p in rawParticipants)
                {
                    Dictionary<string, object> d = p as Dictionary<string, object>;
                    if (d != null) participants.Add(d);
                }
                minParticipants = GetInt(activeTournament, "minParticipants", 3);
                lineupSize = GetInt(activeTournament, "lineupSize", 3);
                winnerDraws = GetInt(activeTournament, "winnerDraws", 1);
                settings = server.ReadSettingsObject();
                tCfg = Obj(settings, "tournament");
                perRoundWinnerEnabled = GetBool(tCfg, "perRoundWinnerEnabled", false);
                championDrawsEnabled = GetBool(tCfg, "championDrawsEnabled", true);

                if (participants.Count < minParticipants)
                {
                    SendChatMessageSafe(GetString(tCfg, "cancelMessage", DefaultTournamentCancel)
                        .Replace("[Anzahl]", participants.Count.ToString())
                        .Replace("[Mindestteilnehmer]", minParticipants.ToString()));
                    activeTournament = null;
                    server.Broadcast("tournamentsignup", "{\"active\":false}");
                    SavePendingState();
                    return;
                }

                activeTournament["state"] = "running";
                server.Broadcast("tournamentsignup", "{\"active\":false}");
                SavePendingState();
            }

            foreach (Dictionary<string, object> participant in participants)
            {
                server.RecordTournamentParticipation(GetString(participant, "login", ""), GetString(participant, "displayName", ""));
            }

            var shuffled = new List<Dictionary<string, object>>(participants);
            lock (BattleRandom)
            {
                for (int i = shuffled.Count - 1; i > 0; i--)
                {
                    int j = BattleRandom.Next(i + 1);
                    Dictionary<string, object> tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
                }
            }

            int totalParticipants = shuffled.Count;
            List<Dictionary<string, object>> round = shuffled;
            int roundNumber = 1;

            // Grows one round at a time as the bracket is resolved. Every match/bye item gets a
            // DEEP-CLONED snapshot of this (see CloneBracketRounds) taken at the exact moment it
            // is enqueued - never a live reference - because the whole bracket (all rounds) is
            // actually resolved synchronously in this one pass, well before any of it has played
            // out on screen. Without cloning, every match's bracket view would already show every
            // future round's winner, spoiling the whole tournament the instant the first match's
            // animation starts. Each snapshot only ever reveals: earlier rounds (already played),
            // this round's matchups (paired, but only already-played ones show a winner), and
            // nothing beyond the current round at all.
            var bracketRounds = new List<Dictionary<string, object>>();
            // Every round winner's pack draw (if enabled) is deliberately NOT played right after
            // their own match - collected here and only played once the whole tournament has
            // concluded, back to back with the champion's bonus draws, so the ongoing bracket
            // isn't interrupted by pack-opening animations mid-tournament.
            var perRoundWinners = new List<object>();
            // Every match/bye/champion item is BUILT here but not yet added to the live queue -
            // see the EnqueueBatchAtFront call at the end of this method for why.
            var priorityItems = new List<Dictionary<string, object>>();

            while (round.Count > 1)
            {
                string roundLabel = round.Count <= 2 ? "Finale" : (round.Count <= 4 ? "Halbfinale" : ("Runde " + roundNumber));
                var winners = new List<Dictionary<string, object>>();
                var roundMatches = new List<object>();
                var roundData = new Dictionary<string, object> { { "label", roundLabel }, { "matches", roundMatches } };
                bracketRounds.Add(roundData);
                int currentRoundIndex = bracketRounds.Count - 1;

                for (int i = 0; i + 1 < round.Count; i += 2)
                {
                    Dictionary<string, object> a = round[i];
                    Dictionary<string, object> b = round[i + 1];
                    string loginA = GetString(a, "login", "");
                    string userA = GetString(a, "displayName", loginA);
                    string loginB = GetString(b, "login", "");
                    string userB = GetString(b, "displayName", loginB);

                    var matchData = new Dictionary<string, object> { { "a", userA }, { "b", userB }, { "winner", null }, { "bye", false } };
                    roundMatches.Add(matchData);
                    int currentMatchIndex = roundMatches.Count - 1;

                    List<Dictionary<string, string>> ownedA = server.GetUserOwnedCardTypes(loginA);
                    List<Dictionary<string, string>> ownedB = server.GetUserOwnedCardTypes(loginB);
                    // A participant may have traded/dusted away cards since joining - rather than
                    // crash the bracket, whichever side can no longer field a lineup forfeits.
                    if (ownedA.Count < lineupSize && ownedB.Count < lineupSize) { matchData["winner"] = "a"; winners.Add(a); continue; }
                    if (ownedA.Count < lineupSize) { matchData["winner"] = "b"; winners.Add(b); continue; }
                    if (ownedB.Count < lineupSize) { matchData["winner"] = "a"; winners.Add(a); continue; }

                    Dictionary<string, object> duelEvent = ResolveTournamentDuel(userA, ownedA, userB, ownedB, lineupSize, settings);
                    duelEvent["tournamentRound"] = roundLabel;
                    duelEvent["bracket"] = new Dictionary<string, object>
                    {
                        { "rounds", CloneBracketRounds(bracketRounds) },
                        { "currentRoundIndex", currentRoundIndex },
                        { "currentMatchIndex", currentMatchIndex },
                        // Lets the overlay compute the FULL bracket skeleton (every future round's
                        // match-box count) up front, even though bracketRounds itself only ever
                        // contains rounds resolved so far - see playBracketTree in battle.js.
                        { "totalParticipants", totalParticipants }
                    };
                    priorityItems.Add(BuildQueueItem("battle", loginA, userA, "tournament", duelEvent));

                    bool winnerIsA = GetString(duelEvent, "winner", "A") == "A";
                    matchData["winner"] = winnerIsA ? "a" : "b";
                    Dictionary<string, object> roundWinner = winnerIsA ? a : b;
                    winners.Add(roundWinner);

                    if (perRoundWinnerEnabled)
                    {
                        perRoundWinners.Add(new Dictionary<string, object>
                        {
                            { "login", GetString(roundWinner, "login", "") },
                            { "displayName", GetString(roundWinner, "displayName", "") }
                        });
                    }
                }

                if (round.Count % 2 == 1)
                {
                    Dictionary<string, object> byeUser = round[round.Count - 1];
                    winners.Add(byeUser);
                    var byeMatchData = new Dictionary<string, object>
                    {
                        { "a", GetString(byeUser, "displayName", GetString(byeUser, "login", "")) },
                        { "b", null }, { "winner", "a" }, { "bye", true }
                    };
                    roundMatches.Add(byeMatchData);
                    priorityItems.Add(BuildQueueItem("tournamentbye", GetString(byeUser, "login", ""), GetString(byeUser, "displayName", ""), "tournament",
                        new Dictionary<string, object>
                        {
                            { "tournamentRound", roundLabel },
                            { "bracket", new Dictionary<string, object>
                                {
                                    { "rounds", CloneBracketRounds(bracketRounds) },
                                    { "currentRoundIndex", currentRoundIndex },
                                    { "currentMatchIndex", roundMatches.Count - 1 },
                                    { "totalParticipants", totalParticipants }
                                }
                            }
                        }));
                }

                round = winners;
                roundNumber++;
            }

            lock (tournamentLock) { activeTournament = null; }
            SavePendingState();
            if (round.Count == 0) { EnqueueBatchAtFront(priorityItems); return; }

            Dictionary<string, object> championEntry = round[0];
            string championLogin = GetString(championEntry, "login", "");
            string championUser = GetString(championEntry, "displayName", championLogin);

            priorityItems.Add(BuildQueueItem("tournamentwon", championLogin, championUser, "tournament", new Dictionary<string, object>
            {
                { "totalParticipants", totalParticipants },
                { "winnerDraws", championDrawsEnabled ? winnerDraws : 0 },
                { "perRoundDraws", perRoundWinners.ToArray() },
                // Lets the overlay do one final "zoom out to the completed tree, final branch
                // turns gold" reveal for the champion - there's no further match afterwards to
                // trigger that reveal the way every earlier round's does (see playBracketTree/
                // playBracketReveal in battle.js), so this item carries the FULLY resolved bracket
                // itself, pointing at the final as the "just decided" match.
                { "bracket", new Dictionary<string, object>
                    {
                        { "rounds", CloneBracketRounds(bracketRounds) },
                        { "currentRoundIndex", bracketRounds.Count - 1 },
                        { "currentMatchIndex", 0 },
                        { "totalParticipants", totalParticipants },
                        { "isChampion", true }
                    }
                }
            }));

            // Every match/bye/champion item is flushed into the live queue in one atomic batch,
            // inserted at the FRONT, only now that the whole bracket has been fully resolved -
            // see EnqueueBatchAtFront's comment for why: this is what makes the tournament start
            // the instant signup closes (ahead of any pack draws already waiting) and play
            // straight through without another draw landing in the middle of it.
            EnqueueBatchAtFront(priorityItems);
        }

// Deep-clones the bracket-so-far into plain Dictionary/List primitives suitable for
        // JSON serialization, independent of any further in-place mutation by the caller.
        private static List<object> CloneBracketRounds(List<Dictionary<string, object>> rounds)
        {
            var clone = new List<object>();
            foreach (Dictionary<string, object> round in rounds)
            {
                var clonedMatches = new List<object>();
                foreach (object mo in (List<object>)round["matches"])
                {
                    clonedMatches.Add(new Dictionary<string, object>((Dictionary<string, object>)mo));
                }
                clone.Add(new Dictionary<string, object> { { "label", round["label"] }, { "matches", clonedMatches } });
            }
            return clone;
        }
    }
}
