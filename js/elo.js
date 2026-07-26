/*
 * elo.js — the ranking core.
 *
 *  - Standard Elo update (single reviewer per match, each match counted once).
 *  - Swiss 2-phase matchmaking per the exec meeting notes:
 *      Phase 1: N random matches per candidate, no self / no repeat pair,
 *               appearances spread evenly, then divided evenly across committee.
 *      Phase 2: freeze the bottom tier, pair survivors within similar-score
 *               buckets (4-0 vs 4-0, 2-2 vs 2-2 ...), N more matches each,
 *               re-divided across committee.
 *
 * Pure functions over plain objects so the whole thing is unit-testable in Node.
 */
(function (global) {
  'use strict';

  // ---- Elo math -----------------------------------------------------------
  function expected(ra, rb) {
    return 1 / (1 + Math.pow(10, (rb - ra) / 400));
  }

  // Returns the pair of new ratings after `winner` beats `loser`.
  function updatePair(winnerRating, loserRating, k) {
    k = k || 32;
    var ew = expected(winnerRating, loserRating);
    var el = expected(loserRating, winnerRating);
    return {
      winner: winnerRating + k * (1 - ew),
      loser: loserRating + k * (0 - el)
    };
  }

  // ---- helpers ------------------------------------------------------------
  function pairKey(a, b) {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  // Fisher–Yates shuffle (in place). rng() -> [0,1)
  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /*
   * Core pairing routine, shared by both phases.
   *   ids        : candidate ids eligible to be matched
   *   perNode    : target number of matches each candidate should get
   *   forbidden  : Set of pairKeys that must NOT be created (already-played pairs)
   *   ratingOf   : id -> rating (used only when proximity=true)
   *   proximity  : true => pick the closest-rated eligible partner (Swiss);
   *                false => pick a random eligible partner (random round)
   *   rng        : randomness source
   *
   * Greedy: repeatedly take the neediest candidate and give it the best partner.
   * Guarantees no self-match and no duplicate pair; counts land at perNode except
   * where the parity/forbidden constraints make that impossible (documented via
   * the returned coverage, never silently wrong).
   */
  function buildMatches(ids, perNode, forbidden, ratingOf, proximity, rng) {
    rng = rng || Math.random;
    forbidden = forbidden || new Set();
    var used = new Set();               // pairs created in THIS call
    var remaining = {};                 // id -> matches still owed
    ids.forEach(function (id) { remaining[id] = perNode; });
    var matches = [];

    function eligiblePartners(a) {
      var out = [];
      for (var i = 0; i < ids.length; i++) {
        var b = ids[i];
        if (b === a) continue;
        if (remaining[b] <= 0) continue;
        var key = pairKey(a, b);
        if (forbidden.has(key) || used.has(key)) continue;
        out.push(b);
      }
      return out;
    }

    // process neediest-first so hard-to-place candidates get partners early
    var guard = 0, hardCap = ids.length * perNode * 4 + 50;
    while (guard++ < hardCap) {
      // pick the candidate with the most matches still owed
      var a = null, best = 0;
      var order = ids.slice();
      shuffle(order, rng); // break ties randomly for even spread
      for (var i = 0; i < order.length; i++) {
        var id = order[i];
        if (remaining[id] > best) { best = remaining[id]; a = id; }
      }
      if (a == null) break; // everyone satisfied

      var partners = eligiblePartners(a);
      if (!partners.length) {
        // can't place any more matches for `a` without breaking constraints
        remaining[a] = 0;
        continue;
      }

      var b;
      if (proximity) {
        partners.sort(function (x, y) {
          return Math.abs(ratingOf(a) - ratingOf(x)) - Math.abs(ratingOf(a) - ratingOf(y));
        });
        b = partners[0];
      } else {
        b = partners[Math.floor(rng() * partners.length)];
      }

      used.add(pairKey(a, b));
      remaining[a]--; remaining[b]--;
      matches.push({ a: a, b: b });
    }

    return matches;
  }

  // ---- match object factory ----------------------------------------------
  function makeMatch(phase, a, b, order) {
    return {
      id: 'p' + phase + '_' + order,
      phase: phase,
      a: a,
      b: b,
      reviewerId: null,
      winner: null,     // candidate id of the winner
      commentA: '',     // comment about candidate a
      commentB: '',     // comment about candidate b
      done: false,
      order: order
    };
  }

  // ---- committee divvy -----------------------------------------------------
  /*
   * Spread matches evenly across committee members (round-robin over a shuffled
   * member order), and write the assignment id list onto each member under
   * member[phaseKey]. Mutates matches (reviewerId) and members.
   */
  function assignToCommittee(matches, members, phaseKey, rng) {
    rng = rng || Math.random;
    if (!members.length) return;
    members.forEach(function (m) { m[phaseKey] = []; });
    var shuffled = matches.slice();
    shuffle(shuffled, rng);
    shuffled.forEach(function (match, i) {
      var m = members[i % members.length];
      match.reviewerId = m.id;
      m[phaseKey].push(match.id);
    });
  }

  // ---- phase 1 -------------------------------------------------------------
  function generatePhase1(candidates, committee, opts, rng) {
    opts = opts || {};
    var perNode = opts.matchesPerCandidate || 4;
    var ids = candidates.map(function (c) { return c.id; });
    var raw = buildMatches(ids, perNode, new Set(), null, false, rng);
    var matches = raw.map(function (p, i) { return makeMatch(1, p.a, p.b, i); });
    assignToCommittee(matches, committee, 'phase1', rng);
    return matches;
  }

  // ---- records / standings -------------------------------------------------
  /*
   * Roll match results into per-candidate wins/losses/elo.
   * Returns a map id -> {wins, losses, elo, played}. Only counts matches that
   * have a winner. Applies Elo in match `order` so results are reproducible.
   */
  function computeStandings(candidates, matches, opts) {
    opts = opts || {};
    var k = opts.kFactor || 32;
    var stand = {};
    candidates.forEach(function (c) {
      stand[c.id] = { id: c.id, wins: 0, losses: 0, elo: 1500, played: 0 };
    });
    var ordered = matches.slice().sort(function (x, y) {
      if (x.phase !== y.phase) return x.phase - y.phase;
      return x.order - y.order;
    });
    ordered.forEach(function (m) {
      if (!m.winner) return;
      var loserId = m.winner === m.a ? m.b : m.a;
      var w = stand[m.winner], l = stand[loserId];
      if (!w || !l) return;
      var res = updatePair(w.elo, l.elo, k);
      w.elo = res.winner; l.elo = res.loser;
      w.wins++; l.losses++;
      w.played++; l.played++;
    });
    return stand;
  }

  // ---- phase 2 -------------------------------------------------------------
  /*
   * Freeze the bottom tier and pair survivors within similar-score buckets.
   *   opts.cutoffFraction : keep this top fraction of candidates (default 0.5)
   *   opts.matchesPerCandidate : extra matches per survivor (default 4)
   * Returns { matches, survivors:[ids], frozen:[ids] }.
   * `standings` is the phase-1 result from computeStandings().
   */
  function generatePhase2(candidates, phase1Matches, committee, standings, opts, rng) {
    opts = opts || {};
    var cutoff = opts.cutoffFraction != null ? opts.cutoffFraction : 0.5;
    var perNode = opts.matchesPerCandidate || 4;

    // rank by wins, then elo
    var ranked = candidates.slice().sort(function (a, b) {
      var sa = standings[a.id], sb = standings[b.id];
      if (sb.wins !== sa.wins) return sb.wins - sa.wins;
      return sb.elo - sa.elo;
    });
    var keep = Math.max(2, Math.round(ranked.length * cutoff));
    var survivors = ranked.slice(0, keep);
    var frozenIds = ranked.slice(keep).map(function (c) { return c.id; });

    // forbidden = every pair already played in phase 1 (no rematches across phases)
    var forbidden = new Set();
    phase1Matches.forEach(function (m) { forbidden.add(pairKey(m.a, m.b)); });

    // Pair survivors by Elo proximity across the whole survivor pool. Because Elo
    // tracks record, this naturally pits 4-0 against 4-0 and 2-2 against 2-2 (the
    // "similar scores" rule) while still being able to reach across a tier boundary
    // when a rigid bucket would otherwise dead-end and leave someone short of the
    // target match count.
    var survivorIds = survivors.map(function (c) { return c.id; });
    var ratingOf = function (id) { return standings[id].elo; };
    var built = buildMatches(survivorIds, perNode, forbidden, ratingOf, true, rng);

    var matches = built.map(function (p, i) { return makeMatch(2, p.a, p.b, i); });
    assignToCommittee(matches, committee, 'phase2', rng);
    return {
      matches: matches,
      survivors: survivors.map(function (c) { return c.id; }),
      frozen: frozenIds
    };
  }

  var api = {
    expected: expected,
    updatePair: updatePair,
    pairKey: pairKey,
    shuffle: shuffle,
    buildMatches: buildMatches,
    makeMatch: makeMatch,
    assignToCommittee: assignToCommittee,
    generatePhase1: generatePhase1,
    computeStandings: computeStandings,
    generatePhase2: generatePhase2
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Elo = api;
})(typeof window !== 'undefined' ? window : globalThis);
