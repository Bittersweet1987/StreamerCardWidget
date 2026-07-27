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
// subOnly=false (normal packs, channel points, "!pack") skips boosters flagged
        // "subExclusive" entirely; subOnly=true (sub/resub/giftsub rewards) picks ONLY among
        // them - the two pools never overlap.
        // subOnly=false: normal boosters only (excludes subExclusive). subOnly=true: subExclusive
        // only. subOnly=null: no filter at all - any enabled booster regardless of the flag (used
        // by Team-Kampf, which draws the streamer's lineup from the whole card pool).
        private string PickRandomBoosterId(bool? subOnly = false)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            object boostersObj;
            if (!settings.TryGetValue("boosters", out boostersObj) || !(boostersObj is object[])) return "";
            var eligible = new List<Dictionary<string, object>>();
            foreach (object item in (object[])boostersObj)
            {
                Dictionary<string, object> booster = item as Dictionary<string, object>;
                if (booster == null) continue;
                if (!GetBool(booster, "enabled", true)) continue;
                if (subOnly.HasValue && GetBool(booster, "subExclusive", false) != subOnly.Value) continue;
                object[] cardIds = booster.ContainsKey("cardIds") && booster["cardIds"] is object[] ? (object[])booster["cardIds"] : new object[0];
                if (cardIds.Length == 0) continue;
                if (!BoosterHasEnabledCard(settings, cardIds)) continue;
                eligible.Add(booster);
            }
            if (eligible.Count == 0) return "";

            var scored = new List<Dictionary<string, object>>();
            foreach (Dictionary<string, object> booster in eligible)
            {
                if (GetDouble(booster, "score", 100) > 0) scored.Add(booster);
            }
            List<Dictionary<string, object>> pool = scored.Count > 0 ? scored : eligible;

            double total = 0;
            foreach (Dictionary<string, object> booster in pool) total += Math.Max(0, GetDouble(booster, "score", 100));
            if (total <= 0) return GetString(pool[0], "id", "");

            double cursor;
            lock (RandomSource) cursor = RandomSource.NextDouble() * total;
            foreach (Dictionary<string, object> booster in pool)
            {
                cursor -= Math.Max(0, GetDouble(booster, "score", 100));
                if (cursor <= 0) return GetString(booster, "id", "");
            }
            return GetString(pool[pool.Count - 1], "id", "");
        }

// ---- "!packs" - lists every currently available booster (title + subtitle as one
        // continuous name, same convention as the draw chat message) together with its actual
        // draw probability - mirrors PickRandomBoosterId(subOnly:false)'s exact eligibility and
        // score-weighting so the percentages shown always match real draw odds. Sub-exclusive
        // boosters are listed too (they're real and available, just not via !pack/Kanalpunkte) but
        // marked with a configurable "(Sub Only)" label instead of a percentage, since they aren't
        // part of the normal weighted pool at all. ----
        private static string BoosterDisplayName(Dictionary<string, object> booster)
        {
            string title = GetString(booster, "title", "Booster");
            string subtitle = GetString(booster, "subtitle", "");
            return String.IsNullOrEmpty(subtitle) ? title : title + " " + subtitle;
        }

internal static string NormalizeRarityId(string rarity)
        {
            string r = (rarity ?? "").Trim().ToLowerInvariant();
            if (DefaultRarityWeights.ContainsKey(r)) return r;
            switch (r)
            {
                case "gewöhnlich": case "gewoehnlich": return "common";
                case "ungewöhnlich": case "ungewoehnlich": return "uncommon";
                case "selten": return "rare";
                case "episch": return "epic";
                case "legendär": case "legendaer": return "legendary";
            }
            return "common";
        }

internal static double RarityWeight(Dictionary<string, object> card, Dictionary<string, object> weightsOverride)
        {
            string id = NormalizeRarityId(GetString(card, "rarity", ""));
            if (weightsOverride != null && weightsOverride.ContainsKey(id))
            {
                double v;
                if (Double.TryParse(Convert.ToString(weightsOverride[id]), out v) && v > 0) return v;
            }
            return DefaultRarityWeights.ContainsKey(id) ? DefaultRarityWeights[id] : 1;
        }

private Dictionary<string, object> FindBooster(Dictionary<string, object> settings, string boosterId)
        {
            object boostersObj;
            if (!settings.TryGetValue("boosters", out boostersObj) || !(boostersObj is object[])) return null;
            foreach (object bo in (object[])boostersObj)
            {
                Dictionary<string, object> b = bo as Dictionary<string, object>;
                if (b != null && GetString(b, "id", "") == boosterId) return b;
            }
            return null;
        }

// Case-insensitive, trimmed exact match on a booster's title - used by the "pick your own
        // pack" channel-points reward and its matching chat command (see HandleSpecificPackDraw),
        // where the viewer types the pack's name themselves. Only enabled boosters are eligible -
        // a disabled one must behave the same as "not found" (refund/usage message), not silently
        // draw from a pack the streamer turned off.
        private Dictionary<string, object> FindBoosterByTitle(Dictionary<string, object> settings, string titleQuery)
        {
            if (String.IsNullOrWhiteSpace(titleQuery)) return null;
            string needle = titleQuery.Trim();
            object boostersObj;
            if (!settings.TryGetValue("boosters", out boostersObj) || !(boostersObj is object[])) return null;
            foreach (object bo in (object[])boostersObj)
            {
                Dictionary<string, object> b = bo as Dictionary<string, object>;
                if (b == null) continue;
                if (!GetBool(b, "enabled", true)) continue;
                // Sub-exclusive boosters must never be reachable by typing their name - that would
                // let any viewer bypass the sub-only restriction just by guessing/knowing the
                // title. Used by both "!show"/"pick your own pack" lookups (HandleShowPackCommand,
                // HandleSpecificPackDrawCommand/HandleSpecificPackRedemption) - none of them may
                // ever resolve to a sub-exclusive pack.
                if (GetBool(b, "subExclusive", false)) continue;
                string title = GetString(b, "title", "");
                if (String.Equals(title, needle, StringComparison.OrdinalIgnoreCase)) return b;
                // Also accept "<Titel> <Untertitel>" combined as one string (e.g. "Jeanne, die
                // Kamikaze Diebin" for a booster titled "Jeanne, die" with subtitle "Kamikaze
                // Diebin") - viewers naturally read/type the pack's full displayed name as it
                // appears on the pack graphic, not just its bare title field.
                string subtitle = GetString(b, "subtitle", "");
                if (!String.IsNullOrWhiteSpace(subtitle) &&
                    String.Equals((title + " " + subtitle).Trim(), needle, StringComparison.OrdinalIgnoreCase))
                {
                    return b;
                }
            }
            return null;
        }

// Picks one enabled card from the booster, weighted by rarity weight (mirrors the overlay's
        // weightedPick). Returns null only if the booster has no eligible cards.
        // minRarityFilter (used by the pity system, see ProcessQueueItem): when set, restricts the
        // pool to cards at or above that rarity first - falls back to the unrestricted pool if the
        // booster happens to have no card that rare, so a pity-guaranteed draw never comes up empty.
        private Dictionary<string, object> PickCardFromBooster(Dictionary<string, object> settings, string boosterId, string minRarityFilter = null)
        {
            Dictionary<string, object> booster = FindBooster(settings, boosterId);
            if (booster == null) return null;
            object idsObj;
            if (!booster.TryGetValue("cardIds", out idsObj) || !(idsObj is object[])) return null;
            var cardIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object cid in (object[])idsObj) cardIds.Add(Convert.ToString(cid));

            object deckObj;
            if (!settings.TryGetValue("deck", out deckObj) || !(deckObj is Dictionary<string, object>)) return null;
            object cardsObj;
            if (!((Dictionary<string, object>)deckObj).TryGetValue("cards", out cardsObj) || !(cardsObj is object[])) return null;

            Dictionary<string, object> weights = Obj(settings, "rarityWeights");
            var pool = new List<Dictionary<string, object>>();
            var poolWeights = new List<double>();
            double total = 0;
            foreach (object co in (object[])cardsObj)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                if (!cardIds.Contains(GetString(card, "id", ""))) continue;
                object en;
                if (card.TryGetValue("enabled", out en) && en is bool && !(bool)en) continue;
                double w = RarityWeight(card, weights);
                if (w <= 0) continue;
                pool.Add(card);
                poolWeights.Add(w);
                total += w;
            }
            if (pool.Count == 0) return null;

            if (!String.IsNullOrEmpty(minRarityFilter))
            {
                int minRank = CardPackServer.GetRarityRank(minRarityFilter);
                var filteredPool = new List<Dictionary<string, object>>();
                var filteredWeights = new List<double>();
                double filteredTotal = 0;
                for (int i = 0; i < pool.Count; i++)
                {
                    if (CardPackServer.GetRarityRank(GetString(pool[i], "rarity", "common")) < minRank) continue;
                    filteredPool.Add(pool[i]);
                    filteredWeights.Add(poolWeights[i]);
                    filteredTotal += poolWeights[i];
                }
                if (filteredPool.Count > 0)
                {
                    pool = filteredPool;
                    poolWeights = filteredWeights;
                    total = filteredTotal;
                }
            }

            double cursor;
            lock (RandomSource) cursor = RandomSource.NextDouble() * total;
            for (int i = 0; i < pool.Count; i++)
            {
                cursor -= poolWeights[i];
                if (cursor <= 0) return pool[i];
            }
            return pool[pool.Count - 1];
        }

private static bool BoosterHasEnabledCard(Dictionary<string, object> settings, object[] cardIds)
        {
            object cardsObj;
            if (!settings.TryGetValue("deck", out cardsObj) || !(cardsObj is Dictionary<string, object>)) return false;
            Dictionary<string, object> deck = (Dictionary<string, object>)cardsObj;
            if (!deck.TryGetValue("cards", out cardsObj) || !(cardsObj is object[])) return false;
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object id in cardIds) ids.Add(Convert.ToString(id));
            foreach (object item in (object[])cardsObj)
            {
                Dictionary<string, object> card = item as Dictionary<string, object>;
                if (card == null) continue;
                if (!ids.Contains(GetString(card, "id", ""))) continue;
                object enabledObj;
                if (!card.TryGetValue("enabled", out enabledObj) || enabledObj == null || !(enabledObj is bool) || (bool)enabledObj) return true;
            }
            return false;
        }

private static double GetDouble(Dictionary<string, object> data, string key, double fallback)
        {
            if (!data.ContainsKey(key) || data[key] == null) return fallback;
            double value;
            return Double.TryParse(Convert.ToString(data[key]), out value) ? value : fallback;
        }

// ---- Action queue: serializes channel-point redemptions and chat commands so that
        // concurrent triggers from multiple viewers are always processed strictly one after
        // another, with a fixed pause between actions. ----

        public void Enqueue(string kind, string login, string displayName, string source)
        {
            Enqueue(kind, login, displayName, source, null);
        }

// extra: additional payload the item should carry (e.g. the ranking type/lists), merged
        // into the queue item so ProcessQueueItem can broadcast it once this item's turn comes up.
        public void Enqueue(string kind, string login, string displayName, string source, Dictionary<string, object> extra)
        {
            var item = BuildQueueItem(kind, login, displayName, source, extra);
            // Anything triggered WHILE a bracket's matches are actually playing back (NOT during
            // its signup window - other animations are still allowed to play over that countdown)
            // is held back instead of joining the live queue, so it can't get interleaved between
            // bracket matches. The bracket's OWN items (per-round/champion draws, all enqueued with
            // source "tournament"/"teamkampf") are the one exception - those must never be
            // deferred, or the bracket would end up waiting on itself. Flushed back into the real
            // queue once playback is over - see FlushDeferredQueueIfIdle.
            if (!IsBracketSource(source) && IsBracketPlaybackBusy())
            {
                lock (queueLock) { deferredQueue.Add(item); }
            }
            else
            {
                lock (queueLock) { actionQueue.Add(item); }
            }
            BroadcastQueue();
            queueSignal.Set();
            SavePendingState();
        }

// Moves every held-back item (see Enqueue) back into the live queue, in the same order
        // they originally arrived, the moment no bracket event is active anymore. Called from
        // QueueLoop on every wake-up, so the flush happens within ~1s of the bracket actually
        // finishing (or immediately, since every Enqueue/queue-completion also signals the loop).
        private void FlushDeferredQueueIfIdle()
        {
            if (IsBracketPlaybackBusy()) return;
            List<Dictionary<string, object>> toFlush = null;
            lock (queueLock)
            {
                if (deferredQueue.Count == 0) return;
                toFlush = new List<Dictionary<string, object>>(deferredQueue);
                deferredQueue.Clear();
                actionQueue.AddRange(toFlush);
            }
            server.Log("queue", "info", toFlush.Count + " zurueckgehaltene Aktion(en) nach Turnier/Team-Kampf-Ende in die Warteschlange eingereiht.");
            BroadcastQueue();
            queueSignal.Set();
            SavePendingState();
        }

// Auto-starts a Team-Kampf that got queued (see StartTeamBattleSignup) because a tournament
        // was still busy at the time. Deliberately checked independently of
        // FlushDeferredQueueIfIdle's own early return - that one bails out while bracket PLAYBACK
        // is busy, which is exactly the state a tournament sits in for most of its lifetime, so
        // nesting this inside it would mean the pending request never gets a chance to fire until
        // some unrelated later event happened to find playback idle. IsBracketEventBusy() is the
        // single source of truth for "is it actually safe to start now" - only once neither a
        // tournament's signup NOR its bracket playback is active does this fire, at which point the
        // Team-Kampf hasn't been "lost" at all - it starts for real, same as if it had been
        // triggered fresh right now.
        private void ResolvePendingTeamBattleIfIdle()
        {
            Dictionary<string, object> pending = null;
            lock (pendingTeamBattleLock)
            {
                if (pendingTeamBattleRequest != null && !IsBracketEventBusy())
                {
                    pending = pendingTeamBattleRequest;
                    pendingTeamBattleRequest = null;
                }
            }
            if (pending == null) return;
            StartTeamBattleSignup(GetString(pending, "login", ""), GetString(pending, "displayName", ""), GetString(pending, "source", ""));
        }

private static Dictionary<string, object> BuildQueueItem(string kind, string login, string displayName, string source, Dictionary<string, object> extra)
        {
            var item = new Dictionary<string, object>
            {
                { "id", Guid.NewGuid().ToString("N") },
                { "kind", kind },
                { "user", displayName },
                { "userLogin", login },
                { "source", source },
                { "triggeredAt", DateTime.UtcNow.ToString("o") }
            };
            if (extra != null)
            {
                foreach (KeyValuePair<string, object> kv in extra) item[kv.Key] = kv.Value;
            }
            return item;
        }

// Atomically inserts a whole batch of already-built items at the FRONT of the queue -
        // ahead of anything already waiting - in a single locked operation, so nothing else can
        // get interleaved between them and pack draws already queued during the signup window
        // don't delay the start. Used by tournament/Team-Kampf resolution (see
        // ResolveTournamentSignup/ResolveTeamBattleSignup) so the bracket/team fight begins the
        // instant signup closes and plays start-to-finish without anything landing in the middle.
        private void EnqueueBatchAtFront(List<Dictionary<string, object>> items)
        {
            if (items == null || items.Count == 0) return;
            lock (queueLock) { actionQueue.InsertRange(0, items); }
            BroadcastQueue();
            queueSignal.Set();
            SavePendingState();
        }

public object[] GetQueueItems()
        {
            lock (queueLock)
            {
                var list = new List<object>();
                // An open trade request runs alongside the draw queue (it does not block draws) but
                // is shown first as a processing item until it is accepted, declined or times out.
                Dictionary<string, object> trade = activeTrade;
                if (trade != null)
                {
                    var tcopy = new Dictionary<string, object>(trade);
                    tcopy["processing"] = true;
                    tcopy["user"] = GetString(trade, "fromUser", "");
                    tcopy["userLogin"] = GetString(trade, "fromLogin", "");
                    list.Add(tcopy);
                }
                // The in-flight item is shown next (with a "processing" flag) so the queue tab
                // reflects the event currently being handled, not just those still waiting.
                if (currentQueueItem != null)
                {
                    var copy = new Dictionary<string, object>(currentQueueItem);
                    copy["processing"] = true;
                    list.Add(copy);
                }
                list.AddRange(actionQueue);
                // Shown last, tagged "deferred" so the admin Queue tab can visibly distinguish
                // "waiting its turn" from "waiting for the current tournament/Team-Kampf to end
                // entirely" - see Enqueue/FlushDeferredQueueIfIdle.
                foreach (Dictionary<string, object> deferred in deferredQueue)
                {
                    var dcopy = new Dictionary<string, object>(deferred);
                    dcopy["deferred"] = true;
                    list.Add(dcopy);
                }
                return list.ToArray();
            }
        }

private void BroadcastQueue()
        {
            server.Broadcast("queue", server.Serializer.Serialize(new Dictionary<string, object> { { "items", GetQueueItems() }, { "paused", queuePaused } }));
        }

// Called by the overlay (POST /api/queue/complete) once it has finished playing the
        // animation for a given event. Releases the queue worker so it can proceed to the
        // 500ms gap and then the next item. The post-draw chat message and live-ticker entry are
        // NOT sent from here (see AnnounceDraw below) - they need to go out the moment the card is
        // actually revealed, well before the whole animation (backs-before-reveal, slide, hold
        // time) has finished playing.
        public void CompleteQueueItem(string eventId, string cardTitle, string boosterTitle)
        {
            if (String.IsNullOrEmpty(eventId)) return;
            if (eventId != awaitingEventId) return;
            completionSignal.Set();
        }

public object[] GetLiveTickerHistory()
        {
            lock (liveTickerHistoryLock) return liveTickerHistory.ToArray();
        }

// Single entry point for every live-ticker event kind (draw/battle/tournament/teamkampf) -
        // the display text is fully pre-formatted here (from an admin-configurable template, see
        // settings.liveTicker.*Message) rather than built client-side from structured fields, so
        // "Texte sollen individuell festlegbar sein" applies uniformly to all four kinds.
        private void PushLiveTickerEntry(string kind, string text, string avatarUrl)
        {
            if (String.IsNullOrEmpty(text)) return;
            var tickerEntry = new Dictionary<string, object>
            {
                { "kind", kind },
                { "text", text },
                { "avatarUrl", avatarUrl }
            };
            lock (liveTickerHistoryLock)
            {
                liveTickerHistory.Add(tickerEntry);
                if (liveTickerHistory.Count > LiveTickerHistoryCap) liveTickerHistory.RemoveAt(0);
                server.SaveLiveTickerHistory(liveTickerHistory.ToArray());
            }
            server.Broadcast("liveticker", server.Serializer.Serialize(tickerEntry));
        }

public void AnnounceDraw(string eventId, string cardTitle, string boosterTitle)
        {
            if (String.IsNullOrEmpty(eventId) || String.IsNullOrEmpty(cardTitle)) return;
            if (eventId != awaitingEventId) return;
            bool isFirst;
            lock (announceLock)
            {
                isFirst = lastAnnouncedEventId != eventId;
                lastAnnouncedEventId = eventId;
            }
            if (!isFirst) return;
            try
            {
                Dictionary<string, object> item;
                lock (queueLock) item = currentQueueItem;
                if (item == null || GetString(item, "kind", "") != "draw") return;
                // NOTE: the post-draw CHAT message is deliberately NOT sent here at reveal anymore -
                // it goes out only once the whole draw animation has finished (see QueueLoop's
                // post-completion block), so chat timing lines up with the animation ending instead
                // of firing a few seconds early while the card is still on screen. The live-ticker
                // entry below stays at reveal, since it's a passive feed, not a chat announcement.
                string userLogin = GetString(item, "userLogin", "");
                string user = GetString(item, "user", "Viewer");
                string tickerCardTitle = GetString(item, "cardTitle", "");
                if (String.IsNullOrEmpty(tickerCardTitle)) tickerCardTitle = cardTitle;
                // Same "Titel Untertitel" convention as SendDrawPostMessage and "!packs" - the
                // server-picked booster title (on the item) is authoritative, the parameter is
                // only a fallback for older cached overlays that haven't reported it back yet.
                string tickerBoosterTitle = GetString(item, "boosterTitle", "");
                if (String.IsNullOrEmpty(tickerBoosterTitle)) tickerBoosterTitle = boosterTitle ?? "";
                string tickerBoosterSubtitle = GetString(item, "boosterSubtitle", "");
                if (!String.IsNullOrEmpty(tickerBoosterSubtitle)) tickerBoosterTitle = tickerBoosterTitle + " " + tickerBoosterSubtitle;
                Dictionary<string, object> ltCfg = Obj(server.ReadSettingsObject(), "liveTicker");
                string text = GetString(ltCfg, "drawMessage", DefaultLiveTickerDrawMessage)
                    .Replace("@userName", user)
                    .Replace("[Kartenname]", tickerCardTitle)
                    .Replace("[Boostername]", tickerBoosterTitle);
                PushLiveTickerEntry("draw", text, GetUserAvatarUrl(userLogin));
            }
            catch { }
        }

private void SendDrawPostMessage(Dictionary<string, object> item, string cardTitle, string boosterTitle)
        {
            string source = GetString(item, "source", "");
            string user = GetString(item, "user", "Viewer");
            Dictionary<string, object> settings = server.ReadSettingsObject();
            string template = null;
            Dictionary<string, object> packCfg = null;
            if (source == "chat")
            {
                // The !pack "Nachricht bei Einloesung" - always sent (no separate toggle).
                packCfg = Obj(Obj(settings, "chatCommands"), "pack");
                template = GetString(packCfg, "successMessage", "");
            }
            else
            {
                // Every other trigger (channel points, bits, community goal, tournament,
                // Team-Kampf, sub/resub/giftsub) shares the same "Nachricht nach der Animation"
                // toggle/template - [Quelle] (see below) is what lets the streamer distinguish
                // which one actually fired in a given message.
                Dictionary<string, object> draw = Obj(settings, "draw");
                if (GetBool(draw, "postMessageEnabled", false)) template = GetString(draw, "postMessage", "");
            }
            if (String.IsNullOrWhiteSpace(template)) return;
            // The server picked the card, so its titles (stored on the item) are authoritative;
            // the overlay-reported ones are only a fallback for older cached overlays.
            string cardT = GetString(item, "cardTitle", "");
            if (String.IsNullOrEmpty(cardT)) cardT = cardTitle ?? "";
            string boosterT = GetString(item, "boosterTitle", "");
            if (String.IsNullOrEmpty(boosterT)) boosterT = boosterTitle ?? "";
            // The booster's subtitle (if any, set via its own "Untertitel" field in the Booster
            // tab) is appended after the booster name, same "Titel Untertitel" convention as
            // "!packs" - so [Boostername] reads as one continuous phrase instead of the subtitle
            // needing its own separate chat variable/placement.
            string boosterSubtitle = GetString(item, "boosterSubtitle", "");
            if (!String.IsNullOrEmpty(boosterSubtitle)) boosterT = boosterT + " " + boosterSubtitle;
            // Count is read AFTER the overlay's own /api/collection persist call (it awaits that
            // before ever calling /api/queue/announce, which is what triggers this), so it already
            // reflects this draw - no off-by-one workaround needed here.
            string login = GetString(item, "userLogin", "");
            string cardId = GetString(item, "cardId", "");
            string boosterId = GetString(item, "boosterId", "");
            string count = "";
            if (!String.IsNullOrEmpty(login) && !String.IsNullOrEmpty(cardId) && !String.IsNullOrEmpty(boosterId))
            {
                count = server.GetCardCount(login, boosterId, cardId).ToString();
            }
            string rarityLang = GetString(Obj(settings, "chatCommands"), "rarityLanguage", "de");
            string rarityLabel = String.IsNullOrEmpty(cardId) ? "" : RarityLabel(server.CardRarity(cardId), rarityLang);
            string sourceLabel = SourceLabel(source, rarityLang);
            string msg = template
                .Replace("@userName", "@" + user)
                .Replace("[Kartenname]", cardT)
                .Replace("[Boostername]", boosterT)
                .Replace("[Besitz]", count)
                .Replace("[Seltenheit]", rarityLabel)
                .Replace("[Quelle]", sourceLabel);
            if (source == "chat") SendCommandOutput(login, packCfg, msg);
            else SendChatMessageSafe(msg);
        }

public void SetQueuePaused(bool paused)
        {
            queuePaused = paused;
            server.Log("queue", "info", paused ? "Warteschlange pausiert - Eintraege werden gesammelt." : "Warteschlange fortgesetzt.");
            if (!paused) queueSignal.Set();
            BroadcastQueue();
        }

public void RemoveQueueItem(string id)
        {
            if (String.IsNullOrEmpty(id)) return;
            lock (queueLock)
            {
                actionQueue.RemoveAll(delegate(Dictionary<string, object> item) { return GetString(item, "id", "") == id; });
                deferredQueue.RemoveAll(delegate(Dictionary<string, object> item) { return GetString(item, "id", "") == id; });
            }
            BroadcastQueue();
            SavePendingState();
        }

public void ClearQueue()
        {
            lock (queueLock) { actionQueue.Clear(); deferredQueue.Clear(); }
            BroadcastQueue();
            SavePendingState();
        }

// Safety upper bound for how long to wait on the overlay's completion ack. Generously
        // covers the real animation length so it is effectively never hit when an overlay is
        // connected, but still bounds the wait if no overlay acks (e.g. OBS source closed).
        private int ComputeQueueTimeoutMs(Dictionary<string, object> item)
        {
            string kind = GetString(item, "kind", "");
            if (kind == "showcollection")
            {
                // The showcase overlay "page-flips" through a booster's cards 9 at a time (see
                // collection.js CARDS_PER_PAGE) instead of showing them all at once, so a booster
                // with many cards takes several page-hold intervals, not just one. This must match
                // that client-side page count, or the timeout undercounts and the server gives up
                // waiting for the completion ack while the overlay is still mid page-flip - which
                // then shows as "done" in the Queue tab while the animation keeps playing.
                const int cardsPerPage = 9;
                Dictionary<string, object> settings = server.ReadSettingsObject();
                int totalPages = 0;
                int boosterCount = 0;
                object boostersObj;
                if (settings.TryGetValue("boosters", out boostersObj) && boostersObj is object[])
                {
                    foreach (object bo in (object[])boostersObj)
                    {
                        Dictionary<string, object> booster = bo as Dictionary<string, object>;
                        if (booster == null) continue;
                        int cardCount = 0;
                        object cardIdsObj;
                        if (booster.TryGetValue("cardIds", out cardIdsObj) && cardIdsObj is object[])
                        {
                            cardCount = ((object[])cardIdsObj).Length;
                        }
                        if (cardCount == 0) continue;
                        boosterCount++;
                        totalPages += (int)Math.Ceiling(cardCount / (double)cardsPerPage);
                    }
                }
                if (totalPages == 0) { totalPages = 1; boosterCount = 1; }
                int secondsPerPage = 12;
                object showcaseObj;
                if (settings.TryGetValue("showcase", out showcaseObj) && showcaseObj is Dictionary<string, object>)
                {
                    secondsPerPage = Math.Max(2, GetInt((Dictionary<string, object>)showcaseObj, "secondsPerBooster", 12));
                }
                // Per page: hold time + ~300ms flip transition. Per booster: ~1s slide in/out.
                return totalPages * (secondsPerPage * 1000 + 300) + boosterCount * 1000 + 8000;
            }
            if (kind == "showpack")
            {
                // Same page-flip timing model as "showcollection" above, but scoped to exactly one
                // named booster and a 5x5=25-per-page grid (see showpack.js SHOWPACK_CARDS_PER_PAGE) -
                // must match that client-side page size or the timeout undercounts.
                const int cardsPerPage = 25;
                string boosterId = GetString(item, "boosterId", "");
                Dictionary<string, object> settings = server.ReadSettingsObject();
                int cardCount = 0;
                object boostersObj;
                if (settings.TryGetValue("boosters", out boostersObj) && boostersObj is object[])
                {
                    foreach (object bo in (object[])boostersObj)
                    {
                        Dictionary<string, object> booster = bo as Dictionary<string, object>;
                        if (booster == null || GetString(booster, "id", "") != boosterId) continue;
                        object cardIdsObj;
                        if (booster.TryGetValue("cardIds", out cardIdsObj) && cardIdsObj is object[]) cardCount = ((object[])cardIdsObj).Length;
                        break;
                    }
                }
                if (cardCount == 0) cardCount = 1;
                int totalPages = (int)Math.Ceiling(cardCount / (double)cardsPerPage);
                int secondsPerPage = 12;
                object showcaseObj;
                if (settings.TryGetValue("showcase", out showcaseObj) && showcaseObj is Dictionary<string, object>)
                {
                    secondsPerPage = Math.Max(2, GetInt((Dictionary<string, object>)showcaseObj, "secondsPerBooster", 12));
                }
                return totalPages * (secondsPerPage * 1000 + 300) + 8000;
            }
            if (kind == "ranking")
            {
                // Battle ranking cycles through up to 4 phases, tournament ranking through 2
                // (wins, participations); card/trade ranking show a single list.
                // GetInt on the item itself: displaySeconds was stored on it by HandleRankingCommand.
                int displaySeconds = Math.Max(2, GetInt(item, "displaySeconds", 8));
                string rankingType = GetString(item, "type", "card");
                int phases = rankingType == "battle" ? 4 : rankingType == "tournament" ? 2 : 1;
                return phases * (displaySeconds * 1000 + 500) + 8000;
            }
            if (kind == "trade")
            {
                // Longest configured trade animation duration ("long" ~9s) plus a safety margin.
                return 20000;
            }
            if (kind == "gift")
            {
                // One-shot reveal (envelope/handover/confetti), all well under 10s - generous margin.
                return 15000;
            }
            if (kind == "communitygoalreached")
            {
                // Matches the overlay's fixed 6s celebration display (see communitygoal.js) plus
                // a safety margin.
                return 12000;
            }
            if (kind == "tournamentbye" || kind == "teamkampfresult" || kind == "loyaltybonusreached")
            {
                // No overlay animation is involved (just chat + enqueuing reward draws as separate
                // future items) - nothing will ever send a completion ack for these, so don't make
                // the queue sit out a real timeout. Before this fix, "teamkampfresult" fell through
                // to the generic 30s default (no case matched it here) and genuinely blocked for the
                // full 30 seconds after every single Team-Kampf before any reward draws could start -
                // the actual "battle" animation ahead of it in the queue already blocks correctly on
                // its own real completion ack, so this item needs no timeout of its own at all.
                return 200;
            }
            if (kind == "tournamentwon")
            {
                // Unlike tournamentbye, THIS one does have a real overlay animation - the champion's
                // "zoom out to the completed tree, final branch turns gold" reveal (see
                // playBracketReveal in battle.js) - and it now acks completion via the SAME eventId
                // the item carries (see the "tournamentwon" broadcast above). This is only the
                // fallback for if the overlay never acks (not connected, animation off): long enough
                // to cover the reveal's own ~4-5s runtime plus margin, so the queue doesn't move on to
                // the winner's pack-draw animations while the reveal might still be playing.
                return 8000;
            }
            if (kind == "battle")
            {
                // A normal 1v1/tournament duel's HP-Leisten-Duell is capped at ~28s client-side
                // (see battle.js maxTotalMs); clash/ranged rounds are shorter. A Team-Kampf can
                // have far more matchups than a single duel though (one per eliminated card on
                // either side), so scale the ceiling with how many matchups this item actually
                // carries instead of using the flat 40s that's generous enough for a normal duel
                // but not for a whole team fight.
                object matchupsObj;
                int matchupCount = item.TryGetValue("hpMatchups", out matchupsObj) && matchupsObj is object[] ? ((object[])matchupsObj).Length : 0;
                if (matchupCount > 1) return Math.Min(180000, 10000 + matchupCount * 6000);
                return 40000;
            }
            if (kind == "teamkampfresult")
            {
                // No overlay animation - just chat + the reward/penalty draws it enqueues.
                return 200;
            }
            // Draw animation is a fixed sequence (~7s) plus reveal time; 30s is a safe ceiling.
            return 30000;
        }

// Start() (and RestartQuietly(), called after every reward sync/delete) can run on
        // multiple concurrent request threads. The previous "if (queueWorkerStarted) return;"
        // check-then-set was not atomic, so two overlapping calls could both pass the check
        // before either flipped the flag, spawning TWO independent QueueLoop threads. Both then
        // shared the same awaitingEventId/completionSignal fields, so one thread's dequeue could
        // stomp the other's - e.g. showcollection waiting for its ack while a second thread
        // immediately dequeued and broadcast the next draw, playing both animations at once.
        // A real lock makes "start the worker" atomic, guaranteeing exactly one QueueLoop ever runs.
        private void StartQueueWorkerOnce()
        {
            lock (queueWorkerStartLock)
            {
                if (queueWorkerStarted) return;
                queueWorkerStarted = true;
                queueRunning = true;
                var worker = new Thread(QueueLoop);
                worker.IsBackground = true;
                worker.Start();
            }
        }

private void QueueLoop()
        {
            while (queueRunning)
            {
                queueSignal.WaitOne(1000);
                // Runs on every wake-up (a new Enqueue, a completed item, or just the 1s timeout) -
                // catches the moment a bracket event finishes regardless of which code path cleared
                // it, without needing an explicit call at every one of those paths.
                FlushDeferredQueueIfIdle();
                ResolvePendingTeamBattleIfIdle();
                // While paused, keep collecting incoming events but don't process any.
                if (queuePaused) continue;
                Dictionary<string, object> item = null;
                lock (queueLock)
                {
                    if (actionQueue.Count > 0)
                    {
                        item = actionQueue[0];
                        actionQueue.RemoveAt(0);
                        currentQueueItem = item;
                    }
                }
                if (item == null) continue;

                // Arm the completion gate BEFORE firing the event so an ack can never be missed,
                // then broadcast the queue so the in-flight item is visible as "processing".
                string eventId = GetString(item, "id", "");
                awaitingEventId = eventId;
                completionSignal.Reset();
                BroadcastQueue();

                try { ProcessQueueItem(item); }
                catch (Exception ex) { server.Log("queue", "error", "Queue-Verarbeitung fehlgeschlagen: " + ex.Message); }

                // Wait until the overlay reports the animation finished (POST /api/queue/complete),
                // so the NEXT event is only fired once the current one has fully played out. A
                // per-kind safety timeout prevents a permanent stall if no overlay is connected.
                bool acked = completionSignal.WaitOne(ComputeQueueTimeoutMs(item));
                string itemKind = GetString(item, "kind", "");
                // tournamentbye/teamkampfresult are chat-only bookkeeping items with no overlay
                // animation at all - nothing will EVER ack them, so warning as if an OBS source
                // might be missing would be actively misleading every single time. tournamentwon
                // DOES have a real animation now (the champion's bracket reveal) and acks like any
                // other - so it's deliberately NOT suppressed here anymore; a missing ack for it is
                // a genuine "is OBS open?" case.
                if (!acked && itemKind != "tournamentbye" && itemKind != "teamkampfresult" && itemKind != "loyaltybonusreached")
                {
                    server.Log("queue", "warn", "Keine Abschluss-Rueckmeldung vom Overlay fuer \"" + itemKind + "\" - nach Timeout fortgefahren. Ist die passende OBS-Quelle geoeffnet und aktuell?");
                }
                awaitingEventId = null;

                // Post-animation chat: any message that must NOT be shown before the animation has
                // finished playing (a card-draw's "you got X" or a duel's winner reveal) is sent
                // HERE, once the overlay has acked completion (or the safety timeout elapsed) - never
                // when the item was enqueued or mid-animation, so chat can't spoil the outcome. The
                // draw's message is rebuilt from the item's server-picked card titles; other kinds
                // carry a ready-made string in "completionChat".
                try
                {
                    if (itemKind == "draw")
                    {
                        SendDrawPostMessage(item, GetString(item, "cardTitle", ""), GetString(item, "boosterTitle", ""));
                    }
                    string completionChat = GetString(item, "completionChat", "");
                    if (!String.IsNullOrEmpty(completionChat)) SendChatMessageSafe(completionChat);
                }
                catch (Exception ex) { server.Log("queue", "error", "Abschluss-Chatnachricht fehlgeschlagen: " + ex.Message); }

                // Only after completion: the mandatory 500ms gap before the next action.
                Thread.Sleep(500);
                lock (queueLock) { currentQueueItem = null; }
                BroadcastQueue();
                // Deliberately NOT saved at dequeue time (only here, once truly finished) - the
                // on-disk snapshot up to now still lists this item as pending, so if the app closes/
                // crashes mid-processing it gets replayed from the top on next start (see
                // LoadPendingState) instead of being half-lost with no way to resume an animation
                // whose overlay session no longer exists anyway.
                SavePendingState();
            }
        }

private void ProcessQueueItem(Dictionary<string, object> item)
        {
            string kind = GetString(item, "kind", "");
            string user = GetString(item, "user", "Viewer");
            string login = GetString(item, "userLogin", user);
            string source = GetString(item, "source", "");

            if (kind == "ranking")
            {
                var rankingEvent = new Dictionary<string, object>(item);
                rankingEvent["eventId"] = GetString(item, "id", DateTime.UtcNow.Ticks.ToString());
                rankingEvent.Remove("id");
                rankingEvent.Remove("kind");
                rankingEvent.Remove("user");
                rankingEvent.Remove("userLogin");
                rankingEvent.Remove("source");
                rankingEvent.Remove("triggeredAt");
                server.Broadcast("ranking", server.Serializer.Serialize(rankingEvent));
                return;
            }

            if (kind == "communitygoalreached")
            {
                // Plays as its own serialized queue item (see RegisterCommunityGoalDraw) so it
                // never overlaps the draw that completed the stage. The chat message and bonus
                // draws for every participant are triggered here, once it's this item's turn.
                // Target/bonusCards/celebrationMessage are baked in at enqueue time (rather than
                // re-read from settings.communityGoal.stages by index) so a later admin edit to
                // the stage list can never point this already-queued item at the wrong stage.
                int target = GetInt(item, "target", 0);
                int bonusCards = Math.Max(1, GetInt(item, "bonusCards", 1));
                string celebrationMessage = GetString(item, "celebrationMessage", DefaultCommunityGoalMessage);
                SendChatMessageSafe(celebrationMessage);

                var celebrationEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(item, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "target", target },
                    { "bonusCards", bonusCards },
                    { "message", celebrationMessage }
                };
                server.Broadcast("communitygoalreached", server.Serializer.Serialize(celebrationEvent));

                object participantsObj;
                if (item.TryGetValue("participants", out participantsObj) && participantsObj is object[])
                {
                    foreach (object po in (object[])participantsObj)
                    {
                        Dictionary<string, object> participant = po as Dictionary<string, object>;
                        if (participant == null) continue;
                        string pLogin = GetString(participant, "login", "");
                        string pName = GetString(participant, "displayName", pLogin);
                        if (String.IsNullOrEmpty(pLogin)) continue;
                        for (int i = 0; i < bonusCards; i++) Enqueue("draw", pLogin, pName, "communitygoal");
                    }
                }
                return;
            }

            if (kind == "loyaltybonusreached")
            {
                // Same "play as its own serialized queue item" reasoning as communitygoalreached
                // above - the streak/tier calculation already happened synchronously inside
                // RegisterLoyaltyDraw (during the draw that completed the day), but the
                // announcement and the bonus draws themselves are deferred to here so they never
                // overlap that draw's own animation.
                string boosterId = GetString(item, "boosterId", "");
                int streakDays = GetInt(item, "streakDays", 0);
                int bonusCards = GetInt(item, "bonusCards", 0);
                Dictionary<string, object> loyaltyCfg = Obj(server.ReadSettingsObject(), "loyaltyBonus");
                SendChatMessageSafe(GetString(loyaltyCfg, "bonusMessage", DefaultLoyaltyBonusMessage)
                    .Replace("@userName", "@" + user)
                    .Replace("[SerienTage]", streakDays.ToString())
                    .Replace("[BonusAnzahl]", bonusCards.ToString()));

                object tiersObj;
                if (item.TryGetValue("tiers", out tiersObj) && tiersObj is object[])
                {
                    foreach (object to in (object[])tiersObj)
                    {
                        Dictionary<string, object> tier = to as Dictionary<string, object>;
                        if (tier == null) continue;
                        int tierBonusCards = Math.Max(1, GetInt(tier, "bonusCards", 1));
                        string minRarity = GetString(tier, "minRarity", "rare");
                        for (int i = 0; i < tierBonusCards; i++)
                        {
                            Enqueue("draw", login, user, "loyalty", new Dictionary<string, object>
                            {
                                { "forcedBoosterId", boosterId },
                                { "forceMinRarity", minRarity },
                                { "loyaltyBonus", true }
                            });
                        }
                    }
                }
                return;
            }

            if (kind == "showcollection")
            {
                server.Log("draw", "info", user + " hat die Sammlung angefordert.");
                var showEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(item, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "user", user },
                    { "userLogin", login },
                    { "source", source }
                };
                server.Broadcast("showcollection", server.Serializer.Serialize(showEvent));
                // Card-name chat text, same for both triggers (channel points and !collection) and
                // fired right as the showcase animation actually starts, not early/late relative to
                // whatever else was ahead of it in the queue.
                SendCollectionChatText(login, user);
                return;
            }

            if (kind == "showpack")
            {
                string boosterId = GetString(item, "boosterId", "");
                string boosterTitle = GetString(item, "boosterTitle", "");
                server.Log("draw", "info", user + " hat das Pack '" + boosterTitle + "' angezeigt.");
                var showPackEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(item, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "user", user },
                    { "userLogin", login },
                    { "source", source },
                    { "boosterId", boosterId },
                    { "boosterTitle", boosterTitle }
                };
                server.Broadcast("showpack", server.Serializer.Serialize(showPackEvent));
                // Fired right as the overlay reveal actually starts, same timing rule as
                // SendCollectionChatText above.
                SendShowPackChatText(login, user, boosterId, boosterTitle);
                return;
            }

            if (kind == "trade" || kind == "battle" || kind == "gift")
            {
                // A tournament match's round-announce chat message is sent HERE - when the queue
                // actually reaches this item - rather than when the whole bracket was resolved
                // (all at once, well before earlier matches finish playing). This keeps chat
                // commentary timing aligned with what's actually animating in OBS at that moment,
                // the same fix applied to the community-goal celebration earlier.
                if (kind == "battle" && item.ContainsKey("tournamentRound"))
                {
                    Dictionary<string, object> tCfg = Obj(server.ReadSettingsObject(), "tournament");
                    SendChatMessageSafe(GetString(tCfg, "roundAnnounceMessage", DefaultTournamentRoundAnnounce)
                        .Replace("[Runde]", GetString(item, "tournamentRound", ""))
                        .Replace("[SpielerA]", GetString(item, "userA", ""))
                        .Replace("[SpielerB]", GetString(item, "userB", "")));
                }

                // Live-ticker entry only for a genuine standalone !battle duel, not a tournament
                // round (those already get their own bracket chat commentary above, and their
                // eventual champion gets a "tournamentwon" ticker entry once the whole thing ends).
                if (kind == "battle" && !item.ContainsKey("tournamentRound"))
                {
                    string winnerUser = GetString(item, "winnerUser", "");
                    string loserUser = GetString(item, "loserUser", "");
                    if (!String.IsNullOrEmpty(winnerUser) && !String.IsNullOrEmpty(loserUser))
                    {
                        Dictionary<string, object> ltCfg = Obj(server.ReadSettingsObject(), "liveTicker");
                        string text = GetString(ltCfg, "battleMessage", DefaultLiveTickerBattleMessage)
                            .Replace("@userNameA", winnerUser)
                            .Replace("@userNameB", loserUser);
                        PushLiveTickerEntry("battle", text, GetUserAvatarUrl(GetString(item, "winnerLogin", "")));
                    }
                }

                // trade/battle carry their full event payload (cards, users, result...) as "extra"
                // on Enqueue - strip the queue-internal bookkeeping fields and broadcast the rest
                // as-is, same pattern as "ranking" above.
                var animEvent = new Dictionary<string, object>(item);
                animEvent["eventId"] = GetString(item, "id", DateTime.UtcNow.Ticks.ToString());
                animEvent.Remove("id");
                animEvent.Remove("kind");
                animEvent.Remove("user");
                animEvent.Remove("userLogin");
                animEvent.Remove("source");
                animEvent.Remove("triggeredAt");
                // Never broadcast the post-animation chat text to the overlay - it's server-only
                // (sent by QueueLoop once the animation finishes), and it names the winner.
                animEvent.Remove("completionChat");
                server.Broadcast(kind, server.Serializer.Serialize(animEvent));
                return;
            }

            if (kind == "tournamentbye")
            {
                Dictionary<string, object> tCfg = Obj(server.ReadSettingsObject(), "tournament");
                SendChatMessageSafe(GetString(tCfg, "byeAnnounceMessage", DefaultTournamentByeAnnounce)
                    .Replace("[Runde]", GetString(item, "tournamentRound", ""))
                    .Replace("[Spieler]", user));
                return;
            }

            if (kind == "tournamentwon")
            {
                Dictionary<string, object> tCfg = Obj(server.ReadSettingsObject(), "tournament");
                int totalParticipants = GetInt(item, "totalParticipants", 0);
                // 0 is a deliberate, valid value here (championDrawsEnabled turned off) - not the
                // "field missing" case, so this must not floor to 1 like most other GetInt uses.
                int winnerDraws = Math.Max(0, GetInt(item, "winnerDraws", 0));
                SendChatMessageSafe(GetString(tCfg, "winnerAnnounceMessage", DefaultTournamentWinnerAnnounce)
                    .Replace("@userName", "@" + user)
                    .Replace("[Teilnehmerzahl]", totalParticipants.ToString())
                    .Replace("[Anzahl]", winnerDraws.ToString()));
                server.Log("commands", "info", user + " hat das Turnier mit " + totalParticipants + " Teilnehmern gewonnen.");
                server.RecordTournamentWin(login, user);

                {
                    Dictionary<string, object> ltCfg = Obj(server.ReadSettingsObject(), "liveTicker");
                    string tickerText = GetString(ltCfg, "tournamentMessage", DefaultLiveTickerTournamentMessage)
                        .Replace("@userName", user)
                        .Replace("[Teilnehmerzahl]", totalParticipants.ToString());
                    PushLiveTickerEntry("tournament", tickerText, GetUserAvatarUrl(login));
                }

                // Every round winner's draw (if that setting is enabled) was deliberately held
                // back until now instead of playing right after their own match - see
                // ResolveTournamentSignup - so the bracket isn't interrupted by pack-opening
                // animations mid-tournament. They play here, before the champion's own bonus
                // draws, so the tournament properly ends on the biggest reward.
                object perRoundDrawsObj;
                if (item.TryGetValue("perRoundDraws", out perRoundDrawsObj) && perRoundDrawsObj is object[])
                {
                    foreach (object po in (object[])perRoundDrawsObj)
                    {
                        Dictionary<string, object> p = po as Dictionary<string, object>;
                        if (p == null) continue;
                        string pLogin = GetString(p, "login", "");
                        string pName = GetString(p, "displayName", pLogin);
                        if (String.IsNullOrEmpty(pLogin)) continue;
                        Enqueue("draw", pLogin, pName, "tournament");
                    }
                }

                for (int i = 0; i < winnerDraws; i++) Enqueue("draw", login, user, "tournament");

                // Broadcast the fully-resolved bracket so the overlay can play the same "zoom out
                // to the tree, final branch turns gold, champion's name locked in" reveal every
                // earlier round gets (see playBracketReveal in battle.js) - there's no further
                // match afterwards to trigger that reveal naturally, so it's fired here instead.
                // Carries the SAME eventId as this queue item so the overlay's completion ack (see
                // enqueueTournamentWon/runQueue in battle.js) actually releases the queue once the
                // multi-second reveal animation finishes - without it, the queue moved on after the
                // generic 200ms "no overlay animation" timeout (see ComputeQueueTimeoutMs) while the
                // reveal was still playing, so the winner's first pack-draw animation started
                // visibly overlapping it in the background.
                object championBracketObj;
                if (item.TryGetValue("bracket", out championBracketObj) && championBracketObj is Dictionary<string, object>)
                {
                    server.Broadcast("tournamentwon", server.Serializer.Serialize(new Dictionary<string, object>
                    {
                        { "bracket", championBracketObj },
                        { "eventId", GetString(item, "id", "") }
                    }));
                }
                return;
            }

            if (kind == "teamkampfresult")
            {
                // Fires only once the (single, multi-matchup) "battle" item ahead of it in the
                // queue has actually finished playing in the overlay - same "chat commentary
                // timing tracks real animation playback" reasoning as tournamentwon above.
                Dictionary<string, object> tbCfg = Obj(server.ReadSettingsObject(), "teamBattle");
                bool communityWon = GetBool(item, "communityWon", false);
                string streamerName = GetString(item, "streamerName", "Streamer");

                // NOTE: the difficulty rubber-band adjustment is recorded synchronously in
                // ResolveTeamBattleSignup instead of here, the instant the outcome is known -
                // not here, since this queue item can sit unprocessed for a while (up to the
                // "battle" item ahead of it timing out, ~180s for a big fight) if the overlay is
                // slow to ack or a streamer starts the next signup right away.
                object participantsObj;
                var participants = new List<Dictionary<string, object>>();
                if (item.TryGetValue("participants", out participantsObj) && participantsObj is List<Dictionary<string, object>>)
                {
                    participants = (List<Dictionary<string, object>>)participantsObj;
                }

                foreach (Dictionary<string, object> statParticipant in participants)
                {
                    string statLogin = GetString(statParticipant, "login", "");
                    string statName = GetString(statParticipant, "displayName", statLogin);
                    if (String.IsNullOrEmpty(statLogin)) continue;
                    server.RecordTeamKampfParticipation(statLogin, statName);
                    server.RecordTeamKampfResult(statLogin, statName, communityWon);
                }

                SendChatMessageSafe((communityWon
                        ? GetString(tbCfg, "winMessage", DefaultTeamBattleWinMessage)
                        : GetString(tbCfg, "loseMessage", DefaultTeamBattleLoseMessage))
                    .Replace("@streamerName", streamerName)
                    .Replace("[Teilnehmerzahl]", participants.Count.ToString()));

                {
                    Dictionary<string, object> ltSettings = server.ReadSettingsObject();
                    Dictionary<string, object> ltCfg = Obj(ltSettings, "liveTicker");
                    string siegerName = communityWon
                        ? (GetString(ltSettings, "language", "de") == "en" ? "The community" : "Die Community")
                        : streamerName;
                    string tickerText = GetString(ltCfg, "teamBattleMessage", DefaultLiveTickerTeamBattleMessage)
                        .Replace("[Sieger]", siegerName)
                        .Replace("@streamerName", streamerName);
                    PushLiveTickerEntry("teamkampf", tickerText, null);
                }

                // "Pro besiegter Karte eine Karte" - independent of the overall win/loss (a
                // participant can defeat streamer cards even in a Team-Kampf the community
                // ultimately loses) and independent of the finisher/win rewards below, which is why
                // it's handled here rather than nested inside the communityWon branch. The draws
                // are only ever enqueued once, right here, at the very end of the whole fight - see
                // defeatsByLogin (tallied in ResolveTeamBattleSignup) for why this can only be
                // computed once the whole HP-elimination result is known.
                object defeatsByLoginObj;
                Dictionary<string, object> defeatsByLoginMap = item.TryGetValue("defeatsByLogin", out defeatsByLoginObj) && defeatsByLoginObj is Dictionary<string, object>
                    ? (Dictionary<string, object>)defeatsByLoginObj
                    : null;

                if (GetBool(tbCfg, "perDefeatEnabled", false) && defeatsByLoginMap != null)
                {
                    int perDefeatDraws = Math.Max(1, GetInt(tbCfg, "perDefeatDraws", 1));
                    foreach (Dictionary<string, object> p in participants)
                    {
                        string pLogin = GetString(p, "login", "");
                        string pName = GetString(p, "displayName", pLogin);
                        if (String.IsNullOrEmpty(pLogin)) continue;
                        object countObj;
                        int defeatCount = defeatsByLoginMap.TryGetValue(pLogin, out countObj) ? Convert.ToInt32(countObj) : 0;
                        if (defeatCount <= 0) continue;
                        int totalDraws = defeatCount * perDefeatDraws;
                        if (GetBool(tbCfg, "perDefeatAnnounceEnabled", true))
                        {
                            SendChatMessageSafe(GetString(tbCfg, "perDefeatMessage", DefaultTeamBattlePerDefeatMessage)
                                .Replace("@userName", "@" + pName)
                                .Replace("[AnzahlBesiegt]", defeatCount.ToString())
                                .Replace("[Anzahl]", totalDraws.ToString()));
                        }
                        for (int i = 0; i < totalDraws; i++) Enqueue("draw", pLogin, pName, "teamkampf");
                    }
                }

                // "Pro besiegter Karte eine Karte FÜR ALLE" - unlike perDefeatEnabled above (only the
                // viewer who personally landed the blow), this rewards EVERY participant for EACH
                // streamer card defeated overall, regardless of who defeated it. Both options can run
                // side by side (a participant who both defeated cards personally AND took part in the
                // team gets both bonuses stacked). Announced once for the whole fight, not per viewer.
                if (GetBool(tbCfg, "perDefeatAllEnabled", false) && defeatsByLoginMap != null)
                {
                    int totalDefeats = 0;
                    foreach (object countObj in defeatsByLoginMap.Values) totalDefeats += Convert.ToInt32(countObj);
                    if (totalDefeats > 0)
                    {
                        int perDefeatAllDraws = Math.Max(1, GetInt(tbCfg, "perDefeatAllDraws", 1));
                        int totalDrawsEach = totalDefeats * perDefeatAllDraws;
                        if (GetBool(tbCfg, "perDefeatAllAnnounceEnabled", true))
                        {
                            SendChatMessageSafe(GetString(tbCfg, "perDefeatAllMessage", DefaultTeamBattlePerDefeatAllMessage)
                                .Replace("[AnzahlBesiegt]", totalDefeats.ToString())
                                .Replace("[Anzahl]", totalDrawsEach.ToString()));
                        }
                        foreach (Dictionary<string, object> p in participants)
                        {
                            string pLogin = GetString(p, "login", "");
                            string pName = GetString(p, "displayName", pLogin);
                            if (String.IsNullOrEmpty(pLogin)) continue;
                            for (int i = 0; i < totalDrawsEach; i++) Enqueue("draw", pLogin, pName, "teamkampf");
                        }
                    }
                }

                if (communityWon)
                {
                    if (GetBool(tbCfg, "rewardsEnabled", true))
                    {
                        int drawsPerParticipant = Math.Max(0, GetInt(tbCfg, "drawsPerParticipant", 1));
                        foreach (Dictionary<string, object> p in participants)
                        {
                            string pLogin = GetString(p, "login", "");
                            string pName = GetString(p, "displayName", pLogin);
                            if (String.IsNullOrEmpty(pLogin)) continue;
                            for (int i = 0; i < drawsPerParticipant; i++) Enqueue("draw", pLogin, pName, "teamkampf");
                        }
                    }

                    // Who landed the finishing blow, announced separately from the general win
                    // message - only relevant when the community actually won (a streamer win has
                    // no "finisher" to credit). The bonus-draw count is only mentioned when that
                    // bonus is actually enabled, via a distinct message template rather than a
                    // token that would otherwise have to disappear conditionally mid-sentence.
                    string finisherLogin = GetString(item, "finisherLogin", "");
                    string finisherDisplayName = GetString(item, "finisherDisplayName", finisherLogin);
                    bool finisherBonusEnabled = GetBool(tbCfg, "finisherBonusEnabled", true);
                    int finisherBonusDraws = Math.Max(0, GetInt(tbCfg, "finisherBonusDraws", 1));
                    if (!String.IsNullOrEmpty(finisherLogin))
                    {
                        SendChatMessageSafe((finisherBonusEnabled
                                ? GetString(tbCfg, "finisherAnnounceMessage", DefaultTeamBattleFinisherMessage)
                                : GetString(tbCfg, "finisherAnnounceMessageNoBonus", DefaultTeamBattleFinisherMessageNoBonus))
                            .Replace("@userName", "@" + finisherDisplayName)
                            .Replace("[Anzahl]", finisherBonusDraws.ToString()));
                        if (finisherBonusEnabled)
                        {
                            for (int i = 0; i < finisherBonusDraws; i++) Enqueue("draw", finisherLogin, finisherDisplayName, "teamkampf");
                        }
                    }
                }
                else if (GetBool(tbCfg, "loseCardOnDefeat", false))
                {
                    bool lostCardAnnounceEnabled = GetBool(tbCfg, "lostCardAnnounceEnabled", true);
                    foreach (Dictionary<string, object> p in participants)
                    {
                        string pLogin = GetString(p, "login", "");
                        string pName = GetString(p, "displayName", pLogin);
                        string boosterId = GetString(p, "boosterId", "");
                        string cardId = GetString(p, "cardId", "");
                        if (String.IsNullOrEmpty(pLogin) || String.IsNullOrEmpty(boosterId) || String.IsNullOrEmpty(cardId)) continue;
                        server.RemoveSingleCardAllowZero(pLogin, pName, boosterId, cardId);
                        if (lostCardAnnounceEnabled)
                        {
                            Dictionary<string, string> lostCardInfo = server.CardDisplayInfo(boosterId, cardId);
                            SendChatMessageSafe(GetString(tbCfg, "lostCardMessage", DefaultTeamBattleLostCardMessage)
                                .Replace("@userName", "@" + pName)
                                .Replace("[Kartenname]", lostCardInfo["cardTitle"])
                                .Replace("[Boostername]", lostCardInfo["boosterTitle"]));
                        }
                    }
                }
                return;
            }

            if (kind == "draw")
            {
                // Booster AND card are picked here on the server (weighted by booster score and
                // rarity weight). Broadcasting the concrete cardId means every overlay shows the
                // same card, and - crucially - the server knows the drawn card/booster by name, so
                // the post-animation chat message works regardless of the overlay's cached version.
                // "Pick your own pack" (channel-points reward + matching chat command, see
                // HandleSpecificPackDraw) already resolved and validated the exact booster the
                // viewer asked for BEFORE this item was ever enqueued - it's carried here as
                // "forcedBoosterId" and takes priority over the normal random pick. Everything else
                // below (pity, rarity weighting within that one booster, etc.) behaves exactly like
                // any other draw.
                string forcedBoosterId = GetString(item, "forcedBoosterId", "");
                bool subExclusivePool = GetString(item, "boosterPool", "") == "subExclusive";
                string boosterId = !String.IsNullOrWhiteSpace(forcedBoosterId) ? forcedBoosterId : PickRandomBoosterId(subExclusivePool);
                if (String.IsNullOrWhiteSpace(boosterId))
                {
                    server.Log("draw", subExclusivePool ? "warn" : "error",
                        user + " hat " + (subExclusivePool ? "eine Sub-Belohnung" : "ein Kartenpack") + " ausgeloest, aber kein " +
                        (subExclusivePool ? "Sub-exklusiver Booster" : "Booster") + " war verfuegbar.");
                    return;
                }
                Dictionary<string, object> settings = server.ReadSettingsObject();
                Dictionary<string, object> booster = FindBooster(settings, boosterId);

                // Pity system: guarantees at least "minRarity" once a viewer has had "threshold"
                // consecutive draws (via either channel points or the chat command - this is the
                // single place both paths funnel through) that didn't reach it, OR immediately if
                // they have banked "!dust" credit left over (see HandleDustCommand).
                Dictionary<string, object> pityCfg = Obj(settings, "pity");
                bool pityEnabled = GetBool(pityCfg, "enabled", false);
                string pityMinRarity = GetString(pityCfg, "minRarity", "rare");
                int pityThreshold = Math.Max(1, GetInt(pityCfg, "threshold", 10));

                // The whole read-modify-write below must hold pityLock for its entire duration
                // (not just inside GetPityEntry/SavePityEntry individually) - a draw is processed
                // on the queue-loop thread while "!dust"/"!dustall" run immediately on the chat
                // dispatch thread, so without a single lock spanning the snapshot-to-save window a
                // concurrent dust command's just-credited points could get silently overwritten by
                // this draw saving back its own (by-then stale) snapshot of the entry - exactly the
                // "wrong amount deducted/credited" symptom reported by users.
                int pityStreak = 0, pityBank = 0, pityTotal = 0;
                bool forcePity = false;
                Dictionary<string, object> card = null;
                lock (pityLock)
                {
                    Dictionary<string, object> pityEntry = pityEnabled ? GetPityEntry(login) : null;
                    pityStreak = pityEntry != null ? GetInt(pityEntry, "streak", 0) : 0;
                    pityBank = pityEntry != null ? GetInt(pityEntry, "bank", 0) : 0;
                    // streak and bank are the SAME currency (both count "!dust"/"!dustall" points and
                    // natural non-hit draws in the same units - see HandleDustCommand/
                    // HandleDustAllCommand) so they're combined into one pool here rather than checked
                    // separately: a leftover bank remainder below one full threshold used to just sit
                    // there forever instead of counting toward the streak's own progress. A forced
                    // guarantee costs exactly one pityThreshold out of the combined total - if the bank
                    // alone already holds several multiples of the threshold, each subsequent eligible
                    // draw keeps forcing (and draining threshold worth of pool) until it drops below it.
                    pityTotal = pityStreak + pityBank;
                    forcePity = pityEnabled && pityTotal >= pityThreshold;

                    // A loyalty-bonus draw (see RegisterLoyaltyDraw/"loyaltybonusreached") carries
                    // its own guaranteed floor rarity independent of the pity system - if both are
                    // in play at once (unlikely, but not impossible), the higher of the two wins.
                    string loyaltyFloorRarity = GetString(item, "forceMinRarity", "");
                    string floorRarity = forcePity ? pityMinRarity : null;
                    if (!String.IsNullOrEmpty(loyaltyFloorRarity) &&
                        (floorRarity == null || CardPackServer.GetRarityRank(loyaltyFloorRarity) > CardPackServer.GetRarityRank(floorRarity)))
                    {
                        floorRarity = loyaltyFloorRarity;
                    }

                    card = PickCardFromBooster(settings, boosterId, floorRarity);

                    if (pityEnabled)
                    {
                        bool metPity = card != null && CardPackServer.GetRarityRank(GetString(card, "rarity", "common")) >= CardPackServer.GetRarityRank(pityMinRarity);
                        if (metPity)
                        {
                            pityEntry["streak"] = 0;
                            // Only actually drain the pool if THIS draw was the one forcing it - a
                            // naturally lucky hit (rarity RNG landed on pityMinRarity+ on its own,
                            // without needing to be forced) must not eat into banked credit.
                            if (forcePity) pityEntry["bank"] = pityTotal - pityThreshold;
                        }
                        else
                        {
                            pityEntry["streak"] = pityStreak + 1;
                        }
                        SavePityEntry(login, pityEntry);
                    }
                }

                // Community goal: every draw (any trigger, including this method's own bonus
                // draws once the goal is reached - RegisterCommunityGoalDraw no-ops while frozen)
                // counts toward the shared progress bar.
                RegisterCommunityGoalDraw(login, user);
                if (!GetBool(item, "loyaltyBonus", false)) RegisterLoyaltyDraw(login, user, boosterId, settings);

                string cardId = card != null ? GetString(card, "id", "") : "";
                string cardTitle = card != null ? GetString(card, "title", "") : "";
                string boosterTitle = booster != null ? GetString(booster, "title", "") : "";
                string boosterSubtitle = booster != null ? GetString(booster, "subtitle", "") : "";
                item["cardTitle"] = cardTitle;
                item["boosterTitle"] = boosterTitle;
                item["boosterSubtitle"] = boosterSubtitle;
                item["cardId"] = cardId;
                item["boosterId"] = boosterId;
                server.Log("draw", "info", user + " hat \"" + cardTitle + "\" aus \"" + boosterTitle + "\" gezogen.");
                var drawEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(item, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "user", user },
                    { "userLogin", login },
                    { "boosterId", boosterId },
                    { "cardId", cardId },
                    { "source", source }
                };
                server.Broadcast("draw", server.Serializer.Serialize(drawEvent));
            }
        }

// ---- Discord webhook: posts a card draw as if the viewer themselves posted it (their
        // Twitch display name as the webhook username, their Twitch avatar as the webhook
        // avatar) - see /api/discord/notify-draw, called by the overlay right after a draw's
        // card is fully revealed with a PNG snapshot of the actual card DOM. ----

        public void NotifyDiscordDraw(string login, string displayName, string cardTitle, string boosterTitle, string rarity, byte[] imageBytes)
        {
            NotifyDiscordDraw(login, displayName, cardTitle, boosterTitle, rarity, imageBytes, false, "");
        }

// isTest (from the admin panel's "Test-Nachricht senden" button, see /api/discord/notify-draw)
        // bypasses the enabled/minRarity gate - it's an explicit manual trigger, not a real draw -
        // and uses the caller-supplied testAvatarUrl (a free-text field in the admin UI) instead of
        // looking the drawer's avatar up via Twitch, so the admin can preview the exact look with any
        // placeholder name/picture without needing a real Twitch account to test against. Returns an
        // error message (null on success) - only surfaced back to the caller for isTest, since a real
        // draw's Discord post is a fire-and-forget side effect that must never affect the draw itself.
        public string NotifyDiscordDraw(string login, string displayName, string cardTitle, string boosterTitle, string rarity, byte[] imageBytes, bool isTest, string testAvatarUrl)
        {
            try
            {
                if (imageBytes == null || imageBytes.Length == 0) return "Kein Kartenbild empfangen.";
                Dictionary<string, object> discordCfg = Obj(server.ReadSettingsObject(), "discord");
                string webhookUrl = GetString(discordCfg, "webhookUrl", "");
                if (String.IsNullOrWhiteSpace(webhookUrl)) return "Keine Webhook-URL hinterlegt.";
                if (!isTest)
                {
                    if (!GetBool(discordCfg, "enabled", false)) return null;
                    string minRarity = GetString(discordCfg, "minRarity", "legendary");
                    if (CardPackServer.GetRarityRank(rarity) < CardPackServer.GetRarityRank(minRarity)) return null;
                }

                string avatarUrl = isTest ? testAvatarUrl : GetUserAvatarUrl(login);
                string content = (isTest ? "🧪 **Test** - " : "") + "🎴 **" + cardTitle + "** aus **" + boosterTitle + "**";
                return PostDiscordWebhook(webhookUrl, String.IsNullOrWhiteSpace(displayName) ? login : displayName, avatarUrl, content, imageBytes);
            }
            catch (Exception ex)
            {
                server.Log("discord", "error", "Discord-Benachrichtigung fehlgeschlagen: " + ex.Message);
                return ex.Message;
            }
        }

// Hand-rolled multipart/form-data POST (no library support for this in the .NET Framework
        // classes already used elsewhere in this file - WebClient can't combine a JSON part with a
        // binary file part the way Discord's webhook API expects). Two parts: "payload_json" (the
        // username/avatar/content) and "file" (the PNG bytes). Returns an error message, or null on
        // a successful (2xx) response.
        private string PostDiscordWebhook(string webhookUrl, string username, string avatarUrl, string content, byte[] imageBytes)
        {
            try
            {
                string boundary = "----CardPackWidgetBoundary" + Guid.NewGuid().ToString("N");
                Dictionary<string, object> payload = new Dictionary<string, object> { { "username", username }, { "content", content } };
                if (!String.IsNullOrWhiteSpace(avatarUrl)) payload["avatar_url"] = avatarUrl;
                string payloadJson = server.Serializer.Serialize(payload);

                MemoryStream body = new MemoryStream();
                byte[] head = Encoding.UTF8.GetBytes(
                    "--" + boundary + "\r\n" +
                    "Content-Disposition: form-data; name=\"payload_json\"\r\n" +
                    "Content-Type: application/json\r\n\r\n" +
                    payloadJson + "\r\n" +
                    "--" + boundary + "\r\n" +
                    "Content-Disposition: form-data; name=\"file\"; filename=\"card.png\"\r\n" +
                    "Content-Type: image/png\r\n\r\n");
                body.Write(head, 0, head.Length);
                body.Write(imageBytes, 0, imageBytes.Length);
                byte[] tail = Encoding.UTF8.GetBytes("\r\n--" + boundary + "--\r\n");
                body.Write(tail, 0, tail.Length);
                byte[] bodyBytes = body.ToArray();

                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(webhookUrl);
                req.Method = "POST";
                req.ContentType = "multipart/form-data; boundary=" + boundary;
                req.Timeout = 15000;
                req.ContentLength = bodyBytes.Length;
                using (Stream reqStream = req.GetRequestStream())
                {
                    reqStream.Write(bodyBytes, 0, bodyBytes.Length);
                }
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) { }
                return null;
            }
            catch (WebException ex)
            {
                string detail = "";
                if (ex.Response != null)
                {
                    using (var reader = new StreamReader(ex.Response.GetResponseStream(), Encoding.UTF8)) { detail = reader.ReadToEnd(); }
                }
                string message = "Discord-Webhook fehlgeschlagen: " + ex.Message + (String.IsNullOrWhiteSpace(detail) ? "" : " - " + detail);
                server.Log("discord", "error", message);
                return message;
            }
            catch (Exception ex)
            {
                server.Log("discord", "error", "Discord-Webhook fehlgeschlagen: " + ex.Message);
                return ex.Message;
            }
        }
    }
}
