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
    public sealed partial class CardPackServer
    {
private void UpdateCollection(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            string user = NormalizeUser(GetString(body, "user", "viewer")).ToLowerInvariant();
            string cardId = GetString(body, "cardId", "");
            string boosterId = GetString(body, "boosterId", "default");
            string variableName = GetString(body, "variableName", boosterId);
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            string collectionKey = String.IsNullOrWhiteSpace(boosterId) ? variableName : boosterId;

            if (body.ContainsKey("collection") && body["collection"] is Dictionary<string, object>)
            {
                Dictionary<string, object> snapshot = (Dictionary<string, object>)body["collection"];
                if (!snapshot.ContainsKey("version")) snapshot["version"] = 1;
                if (!snapshot.ContainsKey("boosterId")) snapshot["boosterId"] = boosterId;
                if (snapshot.ContainsKey("globalVariable")) snapshot.Remove("globalVariable");
                if (!snapshot.ContainsKey("users")) snapshot["users"] = new Dictionary<string, object>();
                collections[collectionKey] = snapshot;
                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                return;
            }

            if (cardId.Length == 0) return;

            Dictionary<string, object> boosterCollection;
            if (collections.ContainsKey(collectionKey) && collections[collectionKey] is Dictionary<string, object>)
            {
                boosterCollection = (Dictionary<string, object>)collections[collectionKey];
            }
            else
            {
                boosterCollection = new Dictionary<string, object>();
                boosterCollection["version"] = 1;
                boosterCollection["boosterId"] = boosterId;
                boosterCollection["users"] = new Dictionary<string, object>();
                collections[collectionKey] = boosterCollection;
            }

            Dictionary<string, object> users = boosterCollection.ContainsKey("users") && boosterCollection["users"] is Dictionary<string, object>
                ? (Dictionary<string, object>)boosterCollection["users"]
                : new Dictionary<string, object>();
            boosterCollection["users"] = users;

            Dictionary<string, object> userData;
            if (users.ContainsKey(user) && users[user] is Dictionary<string, object>)
            {
                userData = (Dictionary<string, object>)users[user];
            }
            else
            {
                userData = new Dictionary<string, object>();
                userData["displayName"] = GetString(body, "user", "viewer");
                userData["cards"] = new Dictionary<string, object>();
                users[user] = userData;
            }

            Dictionary<string, object> cards;
            if (userData.ContainsKey("cards") && userData["cards"] is Dictionary<string, object>)
            {
                cards = (Dictionary<string, object>)userData["cards"];
            }
            else
            {
                cards = new Dictionary<string, object>();
                userData["cards"] = cards;
            }

            int current = 0;
            if (cards.ContainsKey(cardId))
            {
                Int32.TryParse(Convert.ToString(cards[cardId]), out current);
            }
            cards[cardId] = current + 1;
            File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
        }

// ---- Trade support: card/booster/collection access used by the chat trade commands. ----

        // Resolves a free-text card name to a concrete card + its booster. On a miss, returns the
        // closest title as a suggestion so the chat command can answer "did you mean ...?".
        internal Dictionary<string, object> ResolveCardByName(string name)
        {
            var result = new Dictionary<string, object>
            {
                { "found", false }, { "suggestion", "" }, { "cardId", "" }, { "cardTitle", "" }, { "boosterId", "" }, { "boosterTitle", "" }
            };
            if (String.IsNullOrWhiteSpace(name)) return result;
            Dictionary<string, object> settings = ReadSettingsObject();
            object[] cards = SettingsCards(settings);
            object[] boosters = settings.ContainsKey("boosters") && settings["boosters"] is object[] ? (object[])settings["boosters"] : new object[0];

            var cardBooster = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            foreach (object bo in boosters)
            {
                Dictionary<string, object> booster = bo as Dictionary<string, object>;
                if (booster == null) continue;
                object idsObj;
                if (!booster.TryGetValue("cardIds", out idsObj) || !(idsObj is object[])) continue;
                foreach (object cid in (object[])idsObj)
                {
                    string cidStr = Convert.ToString(cid);
                    if (!cardBooster.ContainsKey(cidStr)) cardBooster[cidStr] = booster;
                }
            }

            string target = name.Trim();
            string targetLower = target.ToLowerInvariant();
            string bestTitle = "";
            double bestScore = 0;
            foreach (object co in cards)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                string title = GetString(card, "title", "");
                if (String.IsNullOrWhiteSpace(title)) continue;
                if (String.Equals(title.Trim(), target, StringComparison.OrdinalIgnoreCase))
                {
                    string cardId = GetString(card, "id", "");
                    result["found"] = true;
                    result["cardId"] = cardId;
                    result["cardTitle"] = title;
                    Dictionary<string, object> booster;
                    if (cardBooster.TryGetValue(cardId, out booster))
                    {
                        result["boosterId"] = GetString(booster, "id", "");
                        result["boosterTitle"] = GetString(booster, "title", "");
                    }
                    return result;
                }
                double score = TitleSimilarity(title.Trim().ToLowerInvariant(), targetLower);
                if (score > bestScore) { bestScore = score; bestTitle = title; }
            }
            // Only offer a suggestion once it's a plausible typo/partial match - a raw "closest of
            // all cards" (the old behavior) happily proposed a totally unrelated short title just
            // because it needed fewer character edits than a long, otherwise-very-close title.
            result["suggestion"] = bestScore >= 0.45 ? bestTitle : "";
            return result;
        }

// Used by the live-ticker broadcast (see CompleteQueueItem) to attach the drawn card's
        // rarity for color-coding, without duplicating the whole ResolveCardByName lookup.
        internal string GetCardRarityByTitle(string title)
        {
            if (String.IsNullOrWhiteSpace(title)) return "common";
            Dictionary<string, object> settings = ReadSettingsObject();
            foreach (object co in SettingsCards(settings))
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                if (String.Equals(GetString(card, "title", "").Trim(), title.Trim(), StringComparison.OrdinalIgnoreCase))
                    return GetString(card, "rarity", "common");
            }
            return "common";
        }

// Similarity in [0,1], 1 = identical. Plain Levenshtein distance is unnormalized (a typo
        // in a long title scores "worse" than an unrelated but short title) and ignores that users
        // often type only part of a card's name - both of which made "did you mean" suggestions
        // feel essentially random. This normalizes by length and gives a straight substring match
        // (typing part of the real name) a strong boost over an edit-distance-only comparison.
        internal static double TitleSimilarity(string title, string target)
        {
            if (title.Length == 0 || target.Length == 0) return 0;
            if (title.Contains(target) || target.Contains(title))
            {
                double coverage = (double)Math.Min(title.Length, target.Length) / Math.Max(title.Length, target.Length);
                return 0.75 + 0.25 * coverage;
            }
            int distance = LevenshteinDistance(title, target);
            int maxLen = Math.Max(title.Length, target.Length);
            return 1.0 - (double)distance / maxLen;
        }

internal bool UserExistsInCollections(string login)
        {
            string key = NormalizeUser(login).ToLowerInvariant();
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            foreach (object value in collections.Values)
            {
                Dictionary<string, object> booster = value as Dictionary<string, object>;
                if (booster == null) continue;
                object usersObj;
                if (booster.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>)
                {
                    if (((Dictionary<string, object>)usersObj).ContainsKey(key)) return true;
                }
            }
            return false;
        }

internal int GetCardCount(string login, string boosterId, string cardId)
        {
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            Dictionary<string, object> cards = FindUserCards(collections, boosterId, login);
            return cards == null ? 0 : CardCount(cards, cardId);
        }

// Returns every distinct (boosterId, cardId) type the user owns at least one copy of.
        // Used by the battle system to draw a random, duplicate-free card lineup.
        internal List<Dictionary<string, string>> GetUserOwnedCardTypes(string login)
        {
            var result = new List<Dictionary<string, string>>();
            string key = NormalizeUser(login).ToLowerInvariant();
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            foreach (KeyValuePair<string, object> kv in collections)
            {
                Dictionary<string, object> booster = kv.Value as Dictionary<string, object>;
                if (booster == null) continue;
                object usersObj;
                if (!booster.TryGetValue("users", out usersObj) || !(usersObj is Dictionary<string, object>)) continue;
                object uObj;
                if (!((Dictionary<string, object>)usersObj).TryGetValue(key, out uObj) || !(uObj is Dictionary<string, object>)) continue;
                object cObj;
                if (!((Dictionary<string, object>)uObj).TryGetValue("cards", out cObj) || !(cObj is Dictionary<string, object>)) continue;
                Dictionary<string, object> cards = (Dictionary<string, object>)cObj;
                foreach (string cardId in cards.Keys)
                {
                    if (CardCount(cards, cardId) < 1) continue;
                    result.Add(new Dictionary<string, string> { { "boosterId", kv.Key }, { "cardId", cardId } });
                }
            }
            return result;
        }

// Same result as calling GetUserOwnedCardTypes + GetCardCount + CardDisplayInfo per card,
        // but reads collections.json and settings.json exactly once each regardless of how many
        // card types the user owns - the per-card versions each independently re-read and
        // re-parsed the whole file, including settings.json's several-MB of base64 card images;
        // with dozens of owned card types (see !collection's chat listing) that turned a
        // near-instant lookup into a multi-second-to-multi-minute one.
        internal List<Dictionary<string, string>> GetUserOwnedCardsWithInfo(string login)
        {
            var result = new List<Dictionary<string, string>>();
            string key = NormalizeUser(login).ToLowerInvariant();
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            Dictionary<string, object> settings = ReadSettingsObject();
            object[] cardsArr = SettingsCards(settings);
            object[] boostersArr = settings.ContainsKey("boosters") && settings["boosters"] is object[] ? (object[])settings["boosters"] : new object[0];

            var cardInfoById = new Dictionary<string, Dictionary<string, string>>();
            foreach (object co in cardsArr)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                string id = GetString(card, "id", "");
                if (String.IsNullOrEmpty(id)) continue;
                cardInfoById[id] = new Dictionary<string, string> { { "title", GetString(card, "title", id) }, { "rarity", GetString(card, "rarity", "common") } };
            }
            var boosterTitleById = new Dictionary<string, string>();
            foreach (object bo in boostersArr)
            {
                Dictionary<string, object> booster = bo as Dictionary<string, object>;
                if (booster == null) continue;
                string id = GetString(booster, "id", "");
                if (String.IsNullOrEmpty(id)) continue;
                boosterTitleById[id] = GetString(booster, "title", id);
            }

            foreach (KeyValuePair<string, object> kv in collections)
            {
                Dictionary<string, object> booster = kv.Value as Dictionary<string, object>;
                if (booster == null) continue;
                object usersObj;
                if (!booster.TryGetValue("users", out usersObj) || !(usersObj is Dictionary<string, object>)) continue;
                object uObj;
                if (!((Dictionary<string, object>)usersObj).TryGetValue(key, out uObj) || !(uObj is Dictionary<string, object>)) continue;
                object cObj;
                if (!((Dictionary<string, object>)uObj).TryGetValue("cards", out cObj) || !(cObj is Dictionary<string, object>)) continue;
                Dictionary<string, object> cards = (Dictionary<string, object>)cObj;
                foreach (string cardId in cards.Keys)
                {
                    int count = CardCount(cards, cardId);
                    if (count < 1) continue;
                    string cardTitle = cardId;
                    string rarity = "common";
                    Dictionary<string, string> info;
                    if (cardInfoById.TryGetValue(cardId, out info)) { cardTitle = info["title"]; rarity = info["rarity"]; }
                    string boosterTitle;
                    if (!boosterTitleById.TryGetValue(kv.Key, out boosterTitle)) boosterTitle = kv.Key;
                    result.Add(new Dictionary<string, string>
                    {
                        { "boosterId", kv.Key }, { "cardId", cardId }, { "cardTitle", cardTitle },
                        { "boosterTitle", boosterTitle }, { "rarity", rarity }, { "count", count.ToString() }
                    });
                }
            }
            return result;
        }

// Moves exactly one copy of one card type from loginFrom to loginTo. Returns false if
        // loginFrom no longer owns the card (e.g. traded away between lineup draw and prize payout).
        internal bool TransferSingleCard(string boosterId, string cardId, string loginFrom, string displayFrom, string loginTo, string displayTo)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> gives = EnsureUserCards(collections, boosterId, loginFrom, displayFrom);
                if (CardCount(gives, cardId) < 1) return false;
                Dictionary<string, object> gets = EnsureUserCards(collections, boosterId, loginTo, displayTo);
                SetCount(gives, cardId, CardCount(gives, cardId) - 1);
                SetCount(gets, cardId, CardCount(gets, cardId) + 1);
                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return true;
            }
        }

internal static bool KnownRarityId(string rarity)
        {
            return !String.IsNullOrEmpty(rarity) && KnownRarityIds.Contains(rarity);
        }

// Normalizes a rarity value (English id or German label) to its canonical English id.
        // Mirrors TwitchBridge.NormalizeRarityId; kept as a separate copy since that one is
        // private to TwitchBridge and this needs to be usable from CardPackServer.
        private static string NormalizeRarityIdShared(string rarity)
        {
            string r = (rarity ?? "").Trim().ToLowerInvariant();
            if (KnownRarityIds.Contains(r)) return r;
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

internal static int GetRarityRank(string rarity)
        {
            string id = NormalizeRarityIdShared(rarity);
            int index = Array.IndexOf(RarityOrder, id);
            return index < 0 ? RarityOrder.Length : index;
        }

private static object[] TopByField(List<Dictionary<string, object>> entries, string field, int limit)
        {
            var sorted = new List<Dictionary<string, object>>(entries);
            sorted.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
            {
                return Convert.ToDouble(b[field]).CompareTo(Convert.ToDouble(a[field]));
            });
            var top = new List<object>();
            for (int i = 0; i < sorted.Count && i < limit; i++)
            {
                top.Add(new Dictionary<string, object> { { "user", sorted[i]["user"] }, { "value", sorted[i][field] } });
            }
            return top.ToArray();
        }

// Top owners of one card type for "!ranking <Kartenname>", sorted by copies owned.
        internal object[] GetTopCardOwners(string boosterId, string cardId, int limit)
        {
            var owners = new List<Dictionary<string, object>>();
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            object bObj;
            if (collections.TryGetValue(boosterId, out bObj) && bObj is Dictionary<string, object>)
            {
                object usersObj;
                if (((Dictionary<string, object>)bObj).TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>)
                {
                    foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)usersObj)
                    {
                        Dictionary<string, object> userData = kv.Value as Dictionary<string, object>;
                        if (userData == null) continue;
                        object cObj;
                        if (!userData.TryGetValue("cards", out cObj) || !(cObj is Dictionary<string, object>)) continue;
                        int count = CardCount((Dictionary<string, object>)cObj, cardId);
                        if (count < 1) continue;
                        owners.Add(new Dictionary<string, object> { { "user", GetString(userData, "displayName", kv.Key) }, { "count", count } });
                    }
                }
            }
            owners.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
            {
                return Convert.ToInt32(b["count"]).CompareTo(Convert.ToInt32(a["count"]));
            });
            if (owners.Count > limit) owners.RemoveRange(limit, owners.Count - limit);
            return owners.ToArray();
        }

internal string CardRarity(string cardId)
        {
            lock (cardRarityCacheLock)
            {
                if (cardRarityCache == null)
                {
                    cardRarityCache = new Dictionary<string, string>();
                    object[] cards = SettingsCards(ReadSettingsObject());
                    foreach (object co in cards)
                    {
                        Dictionary<string, object> card = co as Dictionary<string, object>;
                        if (card == null) continue;
                        string id = GetString(card, "id", "");
                        if (String.IsNullOrEmpty(id)) continue;
                        cardRarityCache[id] = NormalizeRarityIdShared(GetString(card, "rarity", ""));
                    }
                }
                string rarity;
                return cardRarityCache.TryGetValue(cardId, out rarity) ? rarity : "common";
            }
        }

private void InvalidateCardRarityCache()
        {
            lock (cardRarityCacheLock) { cardRarityCache = null; }
        }

// Looks up a card's title/booster title purely for display purposes (chat messages, animation).
        internal Dictionary<string, string> CardDisplayInfo(string boosterId, string cardId)
        {
            Dictionary<string, object> settings = ReadSettingsObject();
            object[] cards = SettingsCards(settings);
            object[] boosters = settings.ContainsKey("boosters") && settings["boosters"] is object[] ? (object[])settings["boosters"] : new object[0];
            string cardTitle = cardId;
            string boosterTitle = boosterId;
            string rarity = "common";
            foreach (object co in cards)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                if (GetString(card, "id", "") == cardId) { cardTitle = GetString(card, "title", cardId); rarity = GetString(card, "rarity", "common"); break; }
            }
            foreach (object bo in boosters)
            {
                Dictionary<string, object> booster = bo as Dictionary<string, object>;
                if (booster == null) continue;
                if (GetString(booster, "id", "") == boosterId) { boosterTitle = GetString(booster, "title", boosterId); break; }
            }
            return new Dictionary<string, string> { { "cardTitle", cardTitle }, { "boosterTitle", boosterTitle }, { "rarity", rarity } };
        }

// Performs the full two-sided swap atomically and persists once. A gives cardA (boosterA)
        // and receives cardB (boosterB); B gives cardB and receives cardA. Returns the new counts
        // (A's cardB, B's cardA) or null if either side no longer owns the card being given.
        internal Dictionary<string, object> ApplyTradeSwap(string loginA, string displayA, string boosterA, string cardA,
            string loginB, string displayB, string boosterB, string cardB)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> aGives = EnsureUserCards(collections, boosterA, loginA, displayA);
                if (CardCount(aGives, cardA) < 1) return null;
                Dictionary<string, object> bGives = EnsureUserCards(collections, boosterB, loginB, displayB);
                if (CardCount(bGives, cardB) < 1) return null;
                Dictionary<string, object> aGets = EnsureUserCards(collections, boosterB, loginA, displayA);
                Dictionary<string, object> bGets = EnsureUserCards(collections, boosterA, loginB, displayB);

                SetCount(aGives, cardA, CardCount(aGives, cardA) - 1);
                int aNewCardB = CardCount(aGets, cardB) + 1; SetCount(aGets, cardB, aNewCardB);
                SetCount(bGives, cardB, CardCount(bGives, cardB) - 1);
                int bNewCardA = CardCount(bGets, cardA) + 1; SetCount(bGets, cardA, bNewCardA);

                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return new Dictionary<string, object> { { "aNewCardB", aNewCardB }, { "bNewCardA", bNewCardA } };
            }
        }

// Bulk version of RemoveCardCopies for "!dustall" - dusts EVERY duplicate (keeping exactly
        // 1) of every card type the viewer owns whose rarity rank is STRICTLY BELOW maxRarityRank
        // (see TwitchBridge.GetRarityRank / the dustAllRarity per-user setting), in one single
        // collections.json read+write instead of one file round-trip per card type (see CLAUDE.md's
        // "Batch-Loading statt Pro-Item-Reads" - this can otherwise touch dozens of card types).
        // Returns one entry per card type that was actually reduced.
        internal List<Dictionary<string, string>> DustAllDuplicates(string login, string displayName, int maxRarityRank)
        {
            var result = new List<Dictionary<string, string>>();
            string key = NormalizeUser(login).ToLowerInvariant();
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> settings = ReadSettingsObject();
                object[] cardsArr = SettingsCards(settings);
                var cardInfoById = new Dictionary<string, Dictionary<string, string>>();
                foreach (object co in cardsArr)
                {
                    Dictionary<string, object> card = co as Dictionary<string, object>;
                    if (card == null) continue;
                    string id = GetString(card, "id", "");
                    if (String.IsNullOrEmpty(id)) continue;
                    cardInfoById[id] = new Dictionary<string, string> { { "title", GetString(card, "title", id) }, { "rarity", GetString(card, "rarity", "common") } };
                }

                bool changed = false;
                foreach (KeyValuePair<string, object> kv in collections)
                {
                    Dictionary<string, object> booster = kv.Value as Dictionary<string, object>;
                    if (booster == null) continue;
                    object usersObj;
                    if (!booster.TryGetValue("users", out usersObj) || !(usersObj is Dictionary<string, object>)) continue;
                    object uObj;
                    if (!((Dictionary<string, object>)usersObj).TryGetValue(key, out uObj) || !(uObj is Dictionary<string, object>)) continue;
                    object cObj;
                    if (!((Dictionary<string, object>)uObj).TryGetValue("cards", out cObj) || !(cObj is Dictionary<string, object>)) continue;
                    Dictionary<string, object> cards = (Dictionary<string, object>)cObj;
                    foreach (string cardId in new List<string>(cards.Keys))
                    {
                        int count = CardCount(cards, cardId);
                        if (count < 2) continue;
                        string cardTitle = cardId;
                        string rarity = "common";
                        Dictionary<string, string> info;
                        if (cardInfoById.TryGetValue(cardId, out info)) { cardTitle = info["title"]; rarity = info["rarity"]; }
                        if (GetRarityRank(rarity) > maxRarityRank) continue;
                        int removed = count - 1;
                        SetCount(cards, cardId, 1);
                        changed = true;
                        result.Add(new Dictionary<string, string>
                        {
                            { "boosterId", kv.Key }, { "cardId", cardId }, { "cardTitle", cardTitle },
                            { "rarity", rarity }, { "removedCount", removed.ToString() }
                        });
                    }
                }
                if (changed)
                {
                    File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                    Broadcast("collections", "{\"updated\":true}");
                }
                return result;
            }
        }

// Removes "count" copies of a card from a viewer's collection (used by "!dust") - always
        // keeps at least 1 copy; returns false without changing anything if the viewer doesn't
        // have enough duplicates to spare.
        internal bool RemoveCardCopies(string login, string displayName, string boosterId, string cardId, int count)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> cards = EnsureUserCards(collections, boosterId, login, displayName);
                int current = CardCount(cards, cardId);
                if (current - count < 1) return false;
                SetCount(cards, cardId, current - count);
                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return true;
            }
        }

// Removes exactly one copy of a card, allowed to reach 0 (unlike RemoveCardCopies, which
        // always keeps at least 1 for "!dust"). Used by Team-Kampf: a participant's staked card is
        // a real wager - losing it can mean losing the viewer's only copy.
        internal bool RemoveSingleCardAllowZero(string login, string displayName, string boosterId, string cardId)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> cards = EnsureUserCards(collections, boosterId, login, displayName);
                int current = CardCount(cards, cardId);
                if (current < 1) return false;
                SetCount(cards, cardId, current - 1);
                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return true;
            }
        }

// One-sided gift ("!gift"): moves exactly one copy of a card from the giver's collection
        // to the recipient's, within the same booster. Unlike RemoveCardCopies (used by "!dust"),
        // this allows giving away the giver's last copy - it's an intentional full transfer, not
        // a "spend a spare duplicate" action.
        internal bool ApplyGiftTransfer(string fromLogin, string fromDisplay, string toLogin, string toDisplay, string boosterId, string cardId)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> giverCards = EnsureUserCards(collections, boosterId, fromLogin, fromDisplay);
                if (CardCount(giverCards, cardId) < 1) return false;
                Dictionary<string, object> receiverCards = EnsureUserCards(collections, boosterId, toLogin, toDisplay);

                SetCount(giverCards, cardId, CardCount(giverCards, cardId) - 1);
                SetCount(receiverCards, cardId, CardCount(receiverCards, cardId) + 1);

                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return true;
            }
        }

private static object[] SettingsCards(Dictionary<string, object> settings)
        {
            object deckObj;
            if (settings.TryGetValue("deck", out deckObj) && deckObj is Dictionary<string, object>)
            {
                object cardsObj;
                if (((Dictionary<string, object>)deckObj).TryGetValue("cards", out cardsObj) && cardsObj is object[]) return (object[])cardsObj;
            }
            return new object[0];
        }

private static Dictionary<string, object> FindUserCards(Dictionary<string, object> collections, string boosterId, string login)
        {
            string key = NormalizeUser(login).ToLowerInvariant();
            object bObj;
            if (!collections.TryGetValue(boosterId, out bObj) || !(bObj is Dictionary<string, object>)) return null;
            object usersObj;
            if (!((Dictionary<string, object>)bObj).TryGetValue("users", out usersObj) || !(usersObj is Dictionary<string, object>)) return null;
            object uObj;
            if (!((Dictionary<string, object>)usersObj).TryGetValue(key, out uObj) || !(uObj is Dictionary<string, object>)) return null;
            object cObj;
            if (!((Dictionary<string, object>)uObj).TryGetValue("cards", out cObj) || !(cObj is Dictionary<string, object>)) return null;
            return (Dictionary<string, object>)cObj;
        }

private static Dictionary<string, object> EnsureUserCards(Dictionary<string, object> collections, string boosterId, string login, string displayName)
        {
            object bObj;
            Dictionary<string, object> booster;
            if (collections.TryGetValue(boosterId, out bObj) && bObj is Dictionary<string, object>) booster = (Dictionary<string, object>)bObj;
            else { booster = new Dictionary<string, object> { { "version", 1 }, { "boosterId", boosterId }, { "users", new Dictionary<string, object>() } }; collections[boosterId] = booster; }
            object usersObj;
            Dictionary<string, object> users;
            if (booster.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>) users = (Dictionary<string, object>)usersObj;
            else { users = new Dictionary<string, object>(); booster["users"] = users; }
            string key = NormalizeUser(login).ToLowerInvariant();
            object uObj;
            Dictionary<string, object> userData;
            if (users.TryGetValue(key, out uObj) && uObj is Dictionary<string, object>) userData = (Dictionary<string, object>)uObj;
            else { userData = new Dictionary<string, object> { { "displayName", displayName }, { "cards", new Dictionary<string, object>() } }; users[key] = userData; }
            if (!String.IsNullOrWhiteSpace(displayName)) userData["displayName"] = displayName;
            object cObj;
            Dictionary<string, object> cards;
            if (userData.TryGetValue("cards", out cObj) && cObj is Dictionary<string, object>) cards = (Dictionary<string, object>)cObj;
            else { cards = new Dictionary<string, object>(); userData["cards"] = cards; }
            return cards;
        }

private static int CardCount(Dictionary<string, object> cards, string cardId)
        {
            object o;
            if (!cards.TryGetValue(cardId, out o)) return 0;
            int v;
            return Int32.TryParse(Convert.ToString(o), out v) ? v : 0;
        }

private static void SetCount(Dictionary<string, object> cards, string cardId, int value)
        {
            if (value <= 0) cards.Remove(cardId);
            else cards[cardId] = value;
        }

internal static int LevenshteinDistance(string a, string b)
        {
            if (a == b) return 0;
            if (a.Length == 0) return b.Length;
            if (b.Length == 0) return a.Length;
            int[] prev = new int[b.Length + 1];
            int[] cur = new int[b.Length + 1];
            for (int j = 0; j <= b.Length; j++) prev[j] = j;
            for (int i = 1; i <= a.Length; i++)
            {
                cur[0] = i;
                for (int j = 1; j <= b.Length; j++)
                {
                    int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                    cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                }
                int[] tmp = prev; prev = cur; cur = tmp;
            }
            return prev[b.Length];
        }
    }
}
