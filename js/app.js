/*
 * app.js — bootstrap, session/password gate, routing, and the automatic
 * phase-advancement orchestration. Renders on every DB state change.
 */
(function () {
  'use strict';

  var mount = document.getElementById('app');

  // ---------- tiny DOM helpers (textContent everywhere -> no HTML injection) ----------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  var toastTimer;
  function toast(msg, isError) {
    var t = document.getElementById('toast');
    if (!t) { t = h('div', { id: 'toast', class: 'toast' }); document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast' + (isError ? ' error' : ''); }, 2800);
  }

  function openModal(node) {
    closeModal();
    var backdrop = h('div', { class: 'modal-backdrop', id: 'modal-backdrop',
      onclick: function (e) { if (e.target === backdrop) closeModal(); } }, [node]);
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', escClose);
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    var b = document.getElementById('modal-backdrop');
    if (b) b.remove();
    document.removeEventListener('keydown', escClose);
  }

  // ---------- session (client-only, low-security by design) ----------
  function getRole() { return sessionStorage.getItem('phide_role'); }
  function setRole(r) { sessionStorage.setItem('phide_role', r); }
  function logout() { sessionStorage.removeItem('phide_role'); location.hash = ''; render(); }

  // ---------- routing ----------
  function getRoute() {
    var hash = location.hash.replace(/^#/, '');
    var m = hash.match(/member=([^&]+)/);
    return { memberId: m ? decodeURIComponent(m[1]) : null };
  }
  function navigate(memberId) {
    location.hash = memberId ? 'member=' + encodeURIComponent(memberId) : '';
  }
  window.addEventListener('hashchange', render);

  // ---------- helpers shared with views ----------
  function matchesById(state) {
    var map = {}; state.matches.forEach(function (m) { map[m.id] = m; }); return map;
  }
  function candMap(state) {
    var map = {}; state.candidates.forEach(function (c) { map[c.id] = c; }); return map;
  }
  function assignmentsFor(member, phase) {
    return (phase === 2 ? member.phase2 : member.phase1) || [];
  }
  function memberDone(member, phase, byId) {
    var ids = assignmentsFor(member, phase);
    if (!ids.length) return true; // nothing assigned this phase -> considered done
    return ids.every(function (id) { var m = byId[id]; return m && m.done && m.winner; });
  }
  function memberProgress(member, phase, byId) {
    var ids = assignmentsFor(member, phase);
    var done = ids.filter(function (id) { var m = byId[id]; return m && m.done && m.winner; }).length;
    return { done: done, total: ids.length };
  }

  var ctx = {
    h: h, toast: toast, openModal: openModal, closeModal: closeModal,
    navigate: navigate, logout: logout, render: function () { render(); },
    matchesById: matchesById, candMap: candMap, assignmentsFor: assignmentsFor,
    memberDone: memberDone, memberProgress: memberProgress,
    wizState: {} // per-member wizard view state (index + mode), survives re-renders
  };

  // ---------- automatic phase advancement ----------
  var advancing = false, finalizing = false, lastPhaseSeen = null;
  function orchestrate(state) {
    var cfg = state.config; if (!cfg) return;
    if (cfg.phase !== lastPhaseSeen) { advancing = false; finalizing = false; lastPhaseSeen = cfg.phase; }
    var members = (state.committee && state.committee.members) || [];
    if (!members.length) return;
    var byId = matchesById(state);

    if (cfg.phase === 1 && cfg.pushed && !advancing) {
      var allP1 = members.every(function (m) { return memberDone(m, 1, byId); });
      if (allP1) {
        advancing = true;
        var settings = cfg.settings || DB.DEFAULT_SETTINGS;
        var phase1 = state.matches.filter(function (m) { return m.phase === 1; });
        var standings = Elo.computeStandings(state.candidates, phase1, { kFactor: settings.kFactor });
        var commClone = JSON.parse(JSON.stringify(members));
        var res = Elo.generatePhase2(state.candidates, phase1, commClone, standings, {
          cutoffFraction: settings.p2Cutoff, matchesPerCandidate: settings.p2PerCandidate
        });
        DB.advanceToPhase2(res.matches, commClone).then(function (won) {
          if (won) toast('Phase 1 complete — Phase 2 unlocked for everyone!');
        }).catch(function (e) { advancing = false; console.error(e); });
      }
    }

    if (cfg.phase === 2 && !finalizing) {
      var allP2 = members.every(function (m) { return memberDone(m, 2, byId); });
      if (allP2) {
        finalizing = true;
        DB.finalize().then(function (won) {
          if (won) toast('Phase 2 complete — final rankings are ready!');
        }).catch(function (e) { finalizing = false; console.error(e); });
      }
    }
  }

  // ---------- render ----------
  var initError = null;
  function render() {
    var state = DB.getState();

    if (initError) {
      mount.innerHTML = '';
      mount.appendChild(renderFatal(initError));
      return;
    }
    if (!state.config) {
      mount.innerHTML = '';
      mount.appendChild(h('div', { class: 'center-load' }, [
        h('div', {}, [h('div', { class: 'spinner' }), h('div', { text: 'Connecting…' })])
      ]));
      return;
    }

    orchestrate(state);

    var role = getRole();
    if (!role) {
      mount.innerHTML = '';
      mount.appendChild(renderGate(state));
      return;
    }

    ctx.role = role;
    ctx.isAdmin = role === 'admin';

    var route = getRoute();
    var members = (state.committee && state.committee.members) || [];
    var member = route.memberId ? members.filter(function (m) { return m.id === route.memberId; })[0] : null;

    if (member && state.config.pushed) {
      // Skip rebuilding the wizard when nothing this member depends on changed
      // (e.g. another reviewer just submitted an unrelated match) — avoids
      // disrupting scroll position and in-progress work.
      var sig = Wizard.signature(state, ctx, member);
      if (sig === lastWizardSig && mount.querySelector('.wizard')) return;
      lastWizardSig = sig;
      mount.innerHTML = '';
      Wizard.render(mount, state, ctx, member);
    } else {
      lastWizardSig = null;
      mount.innerHTML = '';
      if (member && !state.config.pushed) navigate(null);
      Dashboard.render(mount, state, ctx);
    }
  }
  var lastWizardSig = null;

  // ---------- password gate ----------
  function renderGate(state) {
    var adminMode = false;
    var wrap = h('div', { class: 'gate-wrap' });
    function build() {
      wrap.innerHTML = '';
      var err = h('div', { class: 'error' });
      var input = h('input', { type: 'password', placeholder: adminMode ? 'Admin password' : 'Team password',
        onkeydown: function (e) { if (e.key === 'Enter') submit(); } });
      function submit() {
        var val = input.value;
        var cfg = state.config;
        if (adminMode) {
          if (val === cfg.adminPassword) { setRole('admin'); render(); }
          else err.textContent = 'Incorrect admin password.';
        } else {
          if (val === cfg.generalPassword) { setRole('general'); render(); }
          else if (val === cfg.adminPassword) { setRole('admin'); render(); }
          else err.textContent = 'Incorrect password.';
        }
      }
      var card = h('div', { class: 'gate' }, [
        h('div', { class: 'logo', text: 'ΦΔΕ' }),
        h('h2', { text: adminMode ? 'Admin login' : 'PhiDE Rush Review' }),
        h('p', { text: adminMode ? 'Enter the admin / SRMO password.' : 'Enter the team password to continue.' }),
        err, input,
        h('button', { class: 'btn', onclick: submit, text: adminMode ? 'Log in as admin' : 'Enter' }),
        h('div', { class: 'toggle muted' }, [
          adminMode
            ? h('a', { onclick: function () { adminMode = false; build(); }, text: '← Back to team login' })
            : h('a', { onclick: function () { adminMode = true; build(); }, text: 'Admin login →' })
        ])
      ]);
      wrap.appendChild(card);
      setTimeout(function () { input.focus(); }, 30);
    }
    build();
    return wrap;
  }

  function renderFatal(msg) {
    return h('div', { class: 'gate-wrap' }, [
      h('div', { class: 'gate' }, [
        h('div', { class: 'logo', text: '!' }),
        h('h2', { text: 'Connection problem' }),
        h('p', { text: msg }),
        h('button', { class: 'btn secondary', onclick: function () { location.reload(); }, text: 'Retry' })
      ])
    ]);
  }

  // expose a couple of helpers views may want
  window.AppCtx = ctx;

  // ---------- boot ----------
  DB.subscribe(render);
  DB.init().catch(function (e) {
    console.error(e);
    if (DB.mode === 'firebase') {
      initError = 'Could not reach Firebase. If this is the first run, make sure Anonymous Authentication is enabled in the Firebase console (Authentication → Sign-in method → Anonymous). See docs/HANDOFF.md.';
    } else {
      initError = e.message || 'Failed to initialize.';
    }
    render();
  });
  render(); // initial loading paint
})();
