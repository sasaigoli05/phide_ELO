/*
 * db.js — the data layer. One public API (window.DB), two interchangeable backends:
 *
 *   - FIREBASE (default): real-time shared state in Cloud Firestore, so every
 *     committee member on their own laptop sees the same data. Requires Anonymous
 *     Authentication to be enabled in the Firebase console (see docs/HANDOFF.md).
 *
 *   - MOCK (add ?mock=1 to the URL): backed by localStorage + BroadcastChannel.
 *     Fully working, including live sync across tabs of the SAME browser. Great for
 *     testing/demoing without touching Firebase. Data never leaves the machine.
 *
 * Data model (identical in both backends):
 *   meta/config      { generalPassword, adminPassword, phase, pushed, settings, ... }
 *   meta/committee   { members: [ {id,name,phase1[],phase2[],...} ] }
 *   candidates/{id}  { ...candidate }
 *   matches/{id}     { ...match }
 *
 * The whole dataset is small (≤120 candidates, ≤360 matches), so the app simply
 * subscribes to the entire world and re-renders on any change. Simpler = more durable.
 */
(function () {
  'use strict';

  var DEFAULT_SETTINGS = {
    p1PerCandidate: 4,   // Phase 1 matches per candidate
    p2Cutoff: 0.67,      // keep this top fraction into Phase 2 (top ~67%)
    p2PerCandidate: 4,   // Phase 2 matches per surviving candidate
    kFactor: 32          // Elo K-factor
  };

  var DEFAULT_CONFIG = {
    generalPassword: 'phide',   // shared team password (changeable in admin settings)
    adminPassword: 'admin',     // admin/SRMO password (changeable in admin settings)
    phase: 0,                   // 0 = not pushed, 1 = phase 1, 2 = phase 2, 'done' = finished
    pushed: false,
    phase2Started: false,
    settings: DEFAULT_SETTINGS
  };

  function isMock() {
    return /[?&]mock=1/.test(window.location.search);
  }

  // ---- shared state cache + subscriber fan-out ---------------------------
  var state = { config: null, committee: null, candidates: [], matches: [] };
  var subscribers = [];
  var readyResolve, readyPromise = new Promise(function (r) { readyResolve = r; });

  function emit() {
    subscribers.forEach(function (cb) {
      try { cb(state); } catch (e) { console.error('subscriber error', e); }
    });
  }

  function subscribe(cb) {
    subscribers.push(cb);
    if (state.config) cb(state); // fire immediately if we already have data
    return function unsubscribe() {
      var i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    };
  }

  // ======================================================================
  //  MOCK BACKEND (localStorage + BroadcastChannel)
  // ======================================================================
  function MockBackend() {
    var KEY = 'phide_elo_mock';
    var chan = ('BroadcastChannel' in window) ? new BroadcastChannel('phide_elo_mock') : null;

    function loadAll() {
      var raw = localStorage.getItem(KEY);
      if (!raw) {
        return { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), committee: { members: [] }, candidates: [], matches: [] };
      }
      try { return JSON.parse(raw); }
      catch (e) { return { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), committee: { members: [] }, candidates: [], matches: [] }; }
    }
    function saveAll(all, silent) {
      localStorage.setItem(KEY, JSON.stringify(all));
      refreshState(all);
      if (!silent && chan) chan.postMessage('changed');
      emit();
    }
    function refreshState(all) {
      state.config = all.config;
      state.committee = all.committee;
      state.candidates = all.candidates;
      state.matches = all.matches;
    }

    if (chan) {
      chan.onmessage = function () { refreshState(loadAll()); emit(); };
    }
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) { refreshState(loadAll()); emit(); }
    });

    return {
      init: function () {
        var all = loadAll();
        refreshState(all);
        readyResolve();
        emit();
        return Promise.resolve();
      },
      pushTemplate: function (payload) {
        var all = loadAll();
        all.config = Object.assign({}, all.config, {
          phase: 1, pushed: true, phase2Started: false,
          settings: payload.settings || all.config.settings
        });
        all.committee = { members: payload.committee };
        all.candidates = payload.candidates;
        all.matches = payload.matches;
        saveAll(all);
        return Promise.resolve();
      },
      savePasswords: function (p) {
        var all = loadAll();
        if (p.generalPassword != null) all.config.generalPassword = p.generalPassword;
        if (p.adminPassword != null) all.config.adminPassword = p.adminPassword;
        saveAll(all);
        return Promise.resolve();
      },
      saveSettings: function (s) {
        var all = loadAll();
        all.config.settings = Object.assign({}, all.config.settings, s);
        saveAll(all);
        return Promise.resolve();
      },
      submitMatch: function (id, result) {
        var all = loadAll();
        var m = all.matches.find(function (x) { return x.id === id; });
        if (m) {
          m.winner = result.winner;
          m.commentA = result.commentA || '';
          m.commentB = result.commentB || '';
          m.done = true;
        }
        saveAll(all);
        return Promise.resolve();
      },
      advanceToPhase2: function (phase2Matches, committeeMembers) {
        var all = loadAll();
        if (all.config.phase !== 1 || all.config.phase2Started) return Promise.resolve(false);
        all.config.phase2Started = true;
        all.config.phase = 2;
        all.committee = { members: committeeMembers };
        all.matches = all.matches.concat(phase2Matches);
        saveAll(all);
        return Promise.resolve(true);
      },
      finalize: function () {
        var all = loadAll();
        if (all.config.phase !== 2) return Promise.resolve(false);
        all.config.phase = 'done';
        saveAll(all);
        return Promise.resolve(true);
      },
      resetAll: function () {
        var all = { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), committee: { members: [] }, candidates: [], matches: [] };
        saveAll(all);
        return Promise.resolve();
      }
    };
  }

  // ======================================================================
  //  FIREBASE BACKEND (Cloud Firestore + Anonymous Auth)
  // ======================================================================
  function FirebaseBackend() {
    var db, fb;
    var have = { config: false, committee: false, candidates: false, matches: false };

    function markReady(which) {
      have[which] = true;
      if (have.config && have.committee && have.candidates && have.matches) {
        readyResolve();
      }
      emit();
    }

    return {
      init: function () {
        if (!window.firebase || !window.FIREBASE_CONFIG) {
          return Promise.reject(new Error('Firebase SDK or config missing'));
        }
        fb = window.firebase;
        fb.initializeApp(window.FIREBASE_CONFIG);
        db = fb.firestore();

        return fb.auth().signInAnonymously()
          .catch(function (e) {
            console.error('Anonymous auth failed. Enable it in Firebase console → Authentication → Sign-in method → Anonymous.', e);
            throw e;
          })
          .then(function () {
            // Ensure the config doc exists (first run seeds defaults).
            var cfgRef = db.collection('meta').doc('config');
            return cfgRef.get().then(function (snap) {
              if (!snap.exists) return cfgRef.set(DEFAULT_CONFIG);
            });
          })
          .then(function () {
            // Live listeners on the whole world.
            db.collection('meta').doc('config').onSnapshot(function (snap) {
              state.config = snap.exists ? snap.data() : JSON.parse(JSON.stringify(DEFAULT_CONFIG));
              markReady('config');
            });
            db.collection('meta').doc('committee').onSnapshot(function (snap) {
              state.committee = snap.exists ? snap.data() : { members: [] };
              markReady('committee');
            });
            db.collection('candidates').onSnapshot(function (qs) {
              var arr = [];
              qs.forEach(function (d) { arr.push(d.data()); });
              arr.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
              state.candidates = arr;
              markReady('candidates');
            });
            db.collection('matches').onSnapshot(function (qs) {
              var arr = [];
              qs.forEach(function (d) { arr.push(d.data()); });
              state.matches = arr;
              markReady('matches');
            });
          });
      },

      pushTemplate: function (payload) {
        var batch = db.batch();
        // config
        batch.set(db.collection('meta').doc('config'), Object.assign({}, state.config || DEFAULT_CONFIG, {
          phase: 1, pushed: true, phase2Started: false,
          settings: payload.settings || (state.config && state.config.settings) || DEFAULT_SETTINGS
        }));
        // committee
        batch.set(db.collection('meta').doc('committee'), { members: payload.committee });
        // candidates
        payload.candidates.forEach(function (c, i) {
          var cc = Object.assign({ order: i }, c);
          batch.set(db.collection('candidates').doc(c.id), cc);
        });
        // matches
        payload.matches.forEach(function (m) {
          batch.set(db.collection('matches').doc(m.id), m);
        });
        return batch.commit();
      },

      savePasswords: function (p) {
        var upd = {};
        if (p.generalPassword != null) upd.generalPassword = p.generalPassword;
        if (p.adminPassword != null) upd.adminPassword = p.adminPassword;
        return db.collection('meta').doc('config').set(upd, { merge: true });
      },

      saveSettings: function (s) {
        return db.collection('meta').doc('config')
          .set({ settings: Object.assign({}, (state.config && state.config.settings) || DEFAULT_SETTINGS, s) }, { merge: true });
      },

      submitMatch: function (id, result) {
        return db.collection('matches').doc(id).set({
          winner: result.winner,
          commentA: result.commentA || '',
          commentB: result.commentB || '',
          done: true
        }, { merge: true });
      },

      // Transactionally flip phase 1 -> 2 exactly once, then write phase-2 data.
      advanceToPhase2: function (phase2Matches, committeeMembers) {
        var cfgRef = db.collection('meta').doc('config');
        return db.runTransaction(function (tx) {
          return tx.get(cfgRef).then(function (snap) {
            var c = snap.data() || {};
            if (c.phase !== 1 || c.phase2Started) {
              return false; // someone else already advanced
            }
            tx.update(cfgRef, { phase2Started: true, phase: 2 });
            return true;
          });
        }).then(function (won) {
          if (!won) return false;
          var batch = db.batch();
          batch.set(db.collection('meta').doc('committee'), { members: committeeMembers });
          phase2Matches.forEach(function (m) { batch.set(db.collection('matches').doc(m.id), m); });
          return batch.commit().then(function () { return true; });
        });
      },

      finalize: function () {
        var cfgRef = db.collection('meta').doc('config');
        return db.runTransaction(function (tx) {
          return tx.get(cfgRef).then(function (snap) {
            var c = snap.data() || {};
            if (c.phase !== 2) return false;
            tx.update(cfgRef, { phase: 'done' });
            return true;
          });
        });
      },

      resetAll: function () {
        // Delete all candidates + matches, reset config + committee.
        return Promise.all([
          db.collection('candidates').get(),
          db.collection('matches').get()
        ]).then(function (res) {
          var docs = [];
          res[0].forEach(function (d) { docs.push(d.ref); });
          res[1].forEach(function (d) { docs.push(d.ref); });
          // batch in chunks of 450
          var chunks = [];
          for (var i = 0; i < docs.length; i += 450) chunks.push(docs.slice(i, i + 450));
          var p = Promise.resolve();
          chunks.forEach(function (chunk) {
            p = p.then(function () {
              var b = db.batch();
              chunk.forEach(function (ref) { b.delete(ref); });
              return b.commit();
            });
          });
          return p;
        }).then(function () {
          var b = db.batch();
          b.set(db.collection('meta').doc('config'), DEFAULT_CONFIG);
          b.set(db.collection('meta').doc('committee'), { members: [] });
          return b.commit();
        });
      }
    };
  }

  // ======================================================================
  //  PUBLIC API
  // ======================================================================
  var backend = isMock() ? MockBackend() : FirebaseBackend();

  window.DB = {
    mode: isMock() ? 'mock' : 'firebase',
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    init: function () { return backend.init(); },
    ready: function () { return readyPromise; },
    getState: function () { return state; },
    subscribe: subscribe,
    pushTemplate: function (p) { return backend.pushTemplate(p); },
    savePasswords: function (p) { return backend.savePasswords(p); },
    saveSettings: function (s) { return backend.saveSettings(s); },
    submitMatch: function (id, r) { return backend.submitMatch(id, r); },
    advanceToPhase2: function (m, c) { return backend.advanceToPhase2(m, c); },
    finalize: function () { return backend.finalize(); },
    resetAll: function () { return backend.resetAll(); }
  };
})();
