/*
 * dashboard.js — the password-gated home screen.
 *   Admin: upload template -> push to committee, settings gear (passwords + Swiss
 *          knobs), reset, download final rankings.
 *   Everyone: the committee grid with two status lights per member; click a name
 *          to open that member's matchups.
 */
window.Dashboard = (function () {
  'use strict';

  var pendingUpload = null; // parsed {candidates, committee} awaiting push

  function phaseBadge(cfg) {
    var h = AppCtx.h;
    if (!cfg.pushed) return h('span', { class: 'badge grey', text: 'Not started' });
    if (cfg.phase === 1) return h('span', { class: 'badge amber', text: 'Phase 1 in progress' });
    if (cfg.phase === 2) return h('span', { class: 'badge amber', text: 'Phase 2 in progress' });
    if (cfg.phase === 'done') return h('span', { class: 'badge', text: 'Complete' });
    return h('span', { class: 'badge grey', text: '—' });
  }

  function topbar(state, ctx) {
    var h = ctx.h, cfg = state.config;
    var actions = [];
    actions.push(h('span', { class: 'badge ' + (ctx.isAdmin ? '' : 'grey'), text: ctx.isAdmin ? 'Admin' : 'Committee' }));
    if (DB.mode === 'mock') actions.push(h('span', { class: 'badge mock', text: 'DEMO (local)' }));
    if (ctx.isAdmin) actions.push(h('button', { class: 'icon-btn', title: 'Settings', onclick: function () { openSettings(state, ctx); }, text: '⚙' }));
    actions.push(h('button', { class: 'btn ghost small', onclick: ctx.logout, text: 'Log out' }));
    return h('div', { class: 'topbar' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'logo', text: 'ΦΔΕ' }),
        h('div', {}, [
          h('h1', { text: 'PhiDE Rush — ELO Review' }),
          h('div', { class: 'sub', text: 'Head-to-head application review' })
        ])
      ]),
      h('div', { class: 'spacer' }),
      h('div', { class: 'actions' }, actions)
    ]);
  }

  function adminToolbar(state, ctx) {
    var h = ctx.h, cfg = state.config;
    var kids = [];

    if (!cfg.pushed) {
      var fileInput = h('input', { type: 'file', class: 'file-input', accept: '.xlsx,.xls' });
      fileInput.addEventListener('change', function (e) { handleFile(e.target.files[0], state, ctx); });
      kids.push(fileInput);
      if (!pendingUpload) {
        kids.push(h('button', { class: 'btn', onclick: function () { fileInput.click(); }, text: '⬆  Upload template' }));
        kids.push(h('span', { class: 'status-line', text: 'Upload the filled-in template spreadsheet to begin.' }));
      } else {
        kids.push(h('button', { class: 'btn', onclick: function () { pushToCommittee(state, ctx); }, text: '🚀  Push to committee' }));
        kids.push(h('button', { class: 'btn secondary', onclick: function () { fileInput.click(); }, text: 'Choose a different file' }));
        kids.push(h('span', { class: 'status-line',
          text: pendingUpload.candidates.length + ' applicants · ' + pendingUpload.committee.length + ' committee members ready to push.' }));
      }
    } else {
      kids.push(h('span', { class: 'status-line' }, [
        document.createTextNode('Status: '), phaseBadge(cfg)
      ]));
      kids.push(h('div', { class: 'spacer' }));
      if (cfg.phase === 'done') {
        kids.push(h('button', { class: 'btn', onclick: function () { downloadResults(state, ctx); }, text: '⬇  Download rankings' }));
      } else {
        kids.push(h('button', { class: 'btn secondary', disabled: true, title: 'Available once Phase 2 is complete', text: '⬇  Download rankings' }));
      }
      // (Reset lives in ⚙ Settings → "Reset rush platform")
    }
    return h('div', { class: 'admin-toolbar' }, kids);
  }

  function handleFile(file, state, ctx) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'array' });
        var parsed = Parse.parseTemplate(wb);
        if (!parsed.candidates.length) { ctx.toast('No applicants found in the sheet.', true); return; }
        if (!parsed.committee.length) { ctx.toast('No committee members found.', true); return; }
        pendingUpload = parsed;
        ctx.toast('Parsed ' + parsed.candidates.length + ' applicants, ' + parsed.committee.length + ' members.');
        ctx.render();
      } catch (err) {
        console.error(err);
        ctx.toast('Could not read that file. Is it the template .xlsx?', true);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function pushToCommittee(state, ctx) {
    if (!pendingUpload) return;
    var settings = (state.config && state.config.settings) || DB.DEFAULT_SETTINGS;
    var committee = JSON.parse(JSON.stringify(pendingUpload.committee));
    var matches = Elo.generatePhase1(pendingUpload.candidates, committee, {
      matchesPerCandidate: settings.p1PerCandidate
    });
    DB.pushTemplate({
      candidates: pendingUpload.candidates,
      committee: committee,
      matches: matches,
      settings: settings
    }).then(function () {
      pendingUpload = null;
      ctx.toast('Pushed to committee — Phase 1 is live!');
    }).catch(function (e) { console.error(e); ctx.toast('Push failed: ' + e.message, true); });
  }

  function downloadResults(state, ctx) {
    try {
      var members = (state.committee && state.committee.members) || [];
      ExportXlsx.download(state.candidates, state.matches, members, 'PhiDE-Rush-Results.xlsx');
      ctx.toast('Downloading rankings…');
    } catch (e) { console.error(e); ctx.toast('Export failed: ' + e.message, true); }
  }

  function confirmReset(state, ctx) {
    var h = ctx.h;
    ctx.openModal(h('div', { class: 'modal' }, [
      h('h3', { text: 'Reset rush platform?' }),
      h('p', { class: 'muted', text: 'This clears the platform for a new rush cycle: it permanently deletes all applications, matchups, picks, and comments, and returns to the upload screen. Passwords and settings are kept. This cannot be undone.' }),
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn secondary', onclick: ctx.closeModal, text: 'Cancel' }),
        h('button', { class: 'btn danger', onclick: function () {
          DB.resetAll().then(function () { pendingUpload = null; ctx.closeModal(); ctx.toast('Platform reset — ready for a new cycle.'); })
            .catch(function (e) { ctx.toast('Reset failed: ' + e.message, true); });
        }, text: 'Yes, reset platform' })
      ])
    ]));
  }

  function openSettings(state, ctx) {
    var h = ctx.h, cfg = state.config, s = cfg.settings || DB.DEFAULT_SETTINGS;
    var genP = h('input', { type: 'text', value: cfg.generalPassword });
    var admP = h('input', { type: 'text', value: cfg.adminPassword });
    var p1 = h('input', { type: 'number', min: '1', max: '20', value: s.p1PerCandidate });
    var cut = h('input', { type: 'number', min: '10', max: '100', value: Math.round(s.p2Cutoff * 100) });
    var p2 = h('input', { type: 'number', min: '1', max: '20', value: s.p2PerCandidate });
    var kf = h('input', { type: 'number', min: '8', max: '64', value: s.kFactor });
    var settingsLocked = cfg.pushed; // Swiss knobs only matter before pushing / for the next phase

    ctx.openModal(h('div', { class: 'modal' }, [
      h('h3', { text: 'Settings' }),
      h('div', { class: 'field' }, [ h('label', { text: 'Team password (shared)' }), genP ]),
      h('div', { class: 'field' }, [ h('label', { text: 'Admin / SRMO password' }), admP ]),
      h('div', { class: 'divider' }),
      h('label', { text: 'Swiss tournament settings' }),
      settingsLocked ? h('p', { class: 'hint', text: 'Phase 1 is already live, so Phase-1 settings are locked. The Phase-2 cutoff and match count still apply when Phase 2 is generated.' }) : null,
      h('div', { class: 'row' }, [
        h('div', { class: 'field' }, [ h('label', { text: 'Phase 1 matches / candidate' }), p1 ]),
        h('div', { class: 'field' }, [ h('label', { text: 'Phase 2 matches / candidate' }), p2 ])
      ]),
      h('div', { class: 'row' }, [
        h('div', { class: 'field' }, [ h('label', { text: 'Keep top % into Phase 2' }), cut ]),
        h('div', { class: 'field' }, [ h('label', { text: 'Elo K-factor' }), kf ])
      ]),
      cfg.pushed ? h('div', { class: 'divider' }) : null,
      cfg.pushed ? h('label', { text: 'Danger zone' }) : null,
      cfg.pushed ? h('p', { class: 'hint', text: 'Clear all applications and results to start a fresh rush cycle. Passwords and settings are kept.' }) : null,
      cfg.pushed ? h('button', { class: 'btn danger', style: 'margin-top:4px', onclick: function () { confirmReset(state, ctx); }, text: '↺  Reset rush platform' }) : null,
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn secondary', onclick: ctx.closeModal, text: 'Cancel' }),
        h('button', { class: 'btn', onclick: function () {
          var tasks = [];
          tasks.push(DB.savePasswords({ generalPassword: genP.value.trim() || 'phide', adminPassword: admP.value.trim() || 'admin' }));
          tasks.push(DB.saveSettings({
            p1PerCandidate: clampInt(p1.value, 1, 20, 4),
            p2PerCandidate: clampInt(p2.value, 1, 20, 4),
            p2Cutoff: clampInt(cut.value, 10, 100, 50) / 100,
            kFactor: clampInt(kf.value, 8, 64, 32)
          }));
          Promise.all(tasks).then(function () { ctx.closeModal(); ctx.toast('Settings saved.'); })
            .catch(function (e) { ctx.toast('Save failed: ' + e.message, true); });
        }, text: 'Save' })
      ])
    ]));
  }
  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10); if (isNaN(n)) return dflt; return Math.max(lo, Math.min(hi, n));
  }

  function memberCard(member, state, ctx) {
    var h = ctx.h, cfg = state.config, byId = ctx.matchesById(state);
    var p1done = ctx.memberDone(member, 1, byId);
    var p2done = ctx.memberDone(member, 2, byId);
    var phaseActive = cfg.phase;

    function lightDot(phaseNum, done) {
      var cls = 'dot locked', label = String(phaseNum);
      var locked = phaseNum > (phaseActive === 'done' ? 2 : phaseActive);
      if (!locked) {
        if (done) { cls = 'dot done'; label = '✓'; }
        else cls = 'dot progress';
      }
      return h('div', { class: 'light' }, [
        h('div', { class: cls, text: label }),
        h('div', { text: 'Phase ' + phaseNum })
      ]);
    }

    // active-phase progress line
    var activePhaseNum = phaseActive === 'done' ? 2 : phaseActive;
    var prog = ctx.memberProgress(member, activePhaseNum, byId);
    var pct = prog.total ? Math.round(prog.done / prog.total * 100) : 100;

    var card = h('div', { class: 'member-card' }, [
      h('div', { class: 'name', text: member.name }),
      h('div', { class: 'lights' }, [ lightDot(1, p1done), lightDot(2, p2done) ]),
      h('div', { class: 'mini-progress' }, [ h('span', { style: 'width:' + pct + '%' }) ]),
      h('div', { class: 'count', text: prog.total ? (prog.done + ' / ' + prog.total + ' matchups') : 'No matchups this phase' })
    ]);
    card.addEventListener('click', function () { ctx.navigate(member.id); });
    return card;
  }

  function render(mount, state, ctx) {
    var h = ctx.h, cfg = state.config;
    mount.appendChild(topbar(state, ctx));

    var container = h('div', { class: 'container' });
    container.appendChild(h('div', { class: 'section-title' }, [
      h('h2', { text: ctx.isAdmin ? 'Admin console' : 'Committee dashboard' }),
      phaseBadge(cfg)
    ]));

    if (ctx.isAdmin) container.appendChild(adminToolbar(state, ctx));

    var members = (state.committee && state.committee.members) || [];
    if (!cfg.pushed || !members.length) {
      container.appendChild(h('div', { class: 'empty-state' }, [
        h('div', { class: 'big', text: '📋' }),
        h('div', { text: ctx.isAdmin
          ? 'No applications loaded yet. Upload the template above and push to the committee.'
          : 'Waiting for the admin to load applications. Check back soon!' })
      ]));
    } else {
      var grid = h('div', { class: 'grid' });
      members.forEach(function (m) { grid.appendChild(memberCard(m, state, ctx)); });
      container.appendChild(grid);
      if (cfg.phase === 'done') {
        container.appendChild(h('p', { class: 'muted', style: 'margin-top:22px;text-align:center',
          text: 'Review is complete. ' + (ctx.isAdmin ? 'Download the final rankings from the toolbar above.' : 'Ask an admin to download the final rankings.') }));
      }
    }
    mount.appendChild(container);
  }

  return { render: render };
})();
