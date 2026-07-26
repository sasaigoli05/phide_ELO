/*
 * wizard.js — the head-to-head review flow for one committee member.
 *   - Anki-style wizard: two full-height, independently scrollable applicant
 *     panels; floating action bar to pick a winner, add per-side comments, and
 *     move back/next. Everything is editable — go back and change any pick.
 *   - Review screen: a table of all this member's matchups (winner highlighted);
 *     click any row to jump back into the wizard. "Phase N complete" when done.
 *
 * View state (current index + wizard/review mode) is kept per-member in
 * AppCtx.wizState so it survives the re-renders triggered by live updates.
 */
window.Wizard = (function () {
  'use strict';

  function stateFor(ctx, memberId) {
    if (!ctx.wizState[memberId]) ctx.wizState[memberId] = { index: 0, mode: 'wizard' };
    return ctx.wizState[memberId];
  }

  function activePhase(cfg) { return cfg.phase === 'done' ? 2 : cfg.phase; }

  function initials(name) {
    return (name || '?').split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase();
  }

  function photoNode(cand, ctx) {
    var h = ctx.h;
    if (cand.photo) {
      var img = h('img', { class: 'photo', src: cand.photo, alt: cand.name, referrerpolicy: 'no-referrer' });
      img.addEventListener('error', function () {
        var ph = h('div', { class: 'photo', text: initials(cand.name) });
        if (img.parentNode) img.parentNode.replaceChild(ph, img);
      });
      return img;
    }
    return h('div', { class: 'photo', text: initials(cand.name) });
  }

  function personPanel(cand, match, ctx) {
    var h = ctx.h;
    var metaBits = [];
    if (cand.year) metaBits.push(cand.year);
    if (cand.majors) metaBits.push(cand.majors);
    var meta = metaBits.join(' · ');
    var minorLine = cand.minors ? 'Minor: ' + cand.minors : '';

    var essays = (cand.essays || []).map(function (e) {
      return h('div', { class: 'essay' }, [
        h('div', { class: 'q', text: e.q }),
        h('div', { class: 'a' + (e.a ? '' : ' empty'), text: e.a || '(no response)' })
      ]);
    });

    var cls = 'person' + (match.winner === cand.id ? ' picked' : '');
    return h('div', { class: cls }, [
      h('div', { class: 'person-head' }, [
        photoNode(cand, ctx),
        h('div', { class: 'pname', text: cand.name }),
        cand.phonetic ? h('div', { class: 'phon', text: '“' + cand.phonetic + '”' }) : null,
        meta ? h('div', { class: 'pmeta', text: meta }) : null,
        minorLine ? h('div', { class: 'pmeta', text: minorLine }) : null
      ]),
      h('div', { class: 'person-body' }, essays)
    ]);
  }

  function commentModal(ctx, cand, match, which) {
    var h = ctx.h;
    var field = which === 'A' ? 'commentA' : 'commentB';
    var ta = h('textarea', { placeholder: 'Notes on ' + cand.name + ' (optional — great for deliberation later)' });
    ta.value = match[field] || '';
    ctx.openModal(h('div', { class: 'modal' }, [
      h('h3', { text: 'Comment · ' + cand.name }),
      h('div', { class: 'field' }, [ ta ]),
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn secondary', onclick: ctx.closeModal, text: 'Cancel' }),
        h('button', { class: 'btn', onclick: function () {
          var patch = { winner: match.winner, commentA: match.commentA || '', commentB: match.commentB || '' };
          patch[field] = ta.value.trim();
          match[field] = ta.value.trim(); // optimistic
          DB.submitMatch(match.id, patch).catch(function (e) { ctx.toast('Save failed: ' + e.message, true); });
          ctx.closeModal(); ctx.toast('Comment saved.'); ctx.render();
        }, text: 'Save comment' })
      ])
    ]));
  }

  function render(mount, state, ctx, member) {
    var h = ctx.h, cfg = state.config;
    var phase = activePhase(cfg);
    var byId = ctx.matchesById(state);
    var cands = ctx.candMap(state);
    var ids = ctx.assignmentsFor(member, phase);
    var st = stateFor(ctx, member.id);
    var prog = ctx.memberProgress(member, phase, byId);
    var allDone = prog.total > 0 && prog.done === prog.total;

    // header
    var header = h('div', { class: 'wizard-top' }, [
      h('button', { class: 'btn ghost small', onclick: function () { ctx.navigate(null); }, text: '← Dashboard' }),
      h('div', { class: 'title', text: member.name + ' · Phase ' + phase }),
      h('div', { class: 'spacer' }),
      h('div', { class: 'wizard-progress', text: prog.done + ' / ' + prog.total }),
      h('div', { class: 'progress-track' }, [ h('span', { style: 'width:' + (prog.total ? (prog.done / prog.total * 100) : 0) + '%' }) ]),
      h('button', { class: 'btn secondary small', onclick: function () {
        st.mode = st.mode === 'review' ? 'wizard' : 'review'; ctx.render();
      }, text: st.mode === 'review' ? 'Back to matchups' : 'Review all' })
    ]);

    var wizard = h('div', { class: 'wizard' }, [ header ]);

    if (!ids.length) {
      wizard.appendChild(h('div', { class: 'center-load', text: 'No matchups are assigned to you for this phase. 🎉' }));
      mount.appendChild(wizard);
      return;
    }

    if (st.mode === 'review') {
      wizard.appendChild(reviewScreen(state, ctx, member, ids, byId, cands, allDone, phase));
      mount.appendChild(wizard);
      return;
    }

    // clamp index
    if (st.index >= ids.length) st.index = ids.length - 1;
    if (st.index < 0) st.index = 0;
    var match = byId[ids[st.index]];
    var A = cands[match.a], B = cands[match.b];

    var arena = h('div', { class: 'arena' }, [ personPanel(A, match, ctx), personPanel(B, match, ctx) ]);

    function pick(id) {
      match.winner = id; // optimistic
      DB.submitMatch(match.id, { winner: id, commentA: match.commentA || '', commentB: match.commentB || '' })
        .catch(function (e) { ctx.toast('Save failed: ' + e.message, true); });
      // advance to next undecided, else next, else go to review if everything is done
      var next = st.index + 1;
      while (next < ids.length && byId[ids[next]].winner) next++;
      if (next < ids.length) st.index = next;
      else if (ids.every(function (i) { return byId[i].winner; })) st.mode = 'review';
      else st.index = Math.min(st.index + 1, ids.length - 1);
      ctx.render();
    }
    function go(delta) {
      st.index = Math.max(0, Math.min(ids.length - 1, st.index + delta));
      ctx.render();
    }

    var pickA = h('button', { class: 'pick-btn' + (match.winner === A.id ? ' active' : ''),
      onclick: function () { pick(A.id); }, text: (match.winner === A.id ? '✓ ' : '') + 'Pick ' + A.name });
    var pickB = h('button', { class: 'pick-btn' + (match.winner === B.id ? ' active' : ''),
      onclick: function () { pick(B.id); }, text: (match.winner === B.id ? '✓ ' : '') + 'Pick ' + B.name });
    var comA = h('button', { class: 'icon-btn comment-btn' + (match.commentA ? ' has-comment' : ''),
      title: 'Comment on ' + A.name, onclick: function () { commentModal(ctx, A, match, 'A'); }, text: '✎' });
    var comB = h('button', { class: 'icon-btn comment-btn' + (match.commentB ? ' has-comment' : ''),
      title: 'Comment on ' + B.name, onclick: function () { commentModal(ctx, B, match, 'B'); }, text: '✎' });

    var actionbar = h('div', { class: 'actionbar' }, [
      h('button', { class: 'icon-btn nav-arrow', title: 'Previous', disabled: st.index === 0, onclick: function () { go(-1); }, text: '←' }),
      h('div', { class: 'side left' }, [ pickA, comA ]),
      h('div', { class: 'side right' }, [ comB, pickB ]),
      h('button', { class: 'icon-btn nav-arrow', title: 'Next', disabled: st.index === ids.length - 1, onclick: function () { go(1); }, text: '→' })
    ]);

    wizard.appendChild(arena);
    wizard.appendChild(actionbar);
    mount.appendChild(wizard);
  }

  function reviewScreen(state, ctx, member, ids, byId, cands, allDone, phase) {
    var h = ctx.h;
    var wrap = h('div', { class: 'container' });
    wrap.appendChild(h('div', { class: 'section-title' }, [
      h('h2', { text: 'Your matchups' }),
      allDone ? h('span', { class: 'badge', text: 'Phase ' + phase + ' complete ✓' })
              : h('span', { class: 'badge amber', text: (ids.filter(function (i) { return !byId[i].winner; }).length) + ' left' })
    ]));
    wrap.appendChild(h('p', { class: 'muted',
      text: allDone ? 'All done! You can still click any matchup to change your pick or edit comments.'
                    : 'Click any matchup to review it. Winner is highlighted in green.' }));

    var rows = h('div', { class: 'review-rows' });
    ids.forEach(function (id, i) {
      var m = byId[id];
      var A = cands[m.a], B = cands[m.b];
      var aClass = 'half', bClass = 'half right';
      if (m.winner === A.id) { aClass += ' win'; bClass += ' loss'; }
      else if (m.winner === B.id) { aClass += ' loss'; bClass += ' win'; }
      else { aClass += ' pending'; bClass += ' pending'; }
      var row = h('div', { class: 'review-row' }, [
        h('div', { class: aClass }, [
          m.winner === A.id ? h('span', { class: 'tick', text: '✓' }) : null,
          document.createTextNode(A.name),
          m.commentA ? h('span', { class: 'review-note', text: ' · 💬' }) : null
        ]),
        h('div', { class: bClass }, [
          m.commentB ? h('span', { class: 'review-note', text: '💬 · ' }) : null,
          document.createTextNode(B.name),
          m.winner === B.id ? h('span', { class: 'tick', text: '✓' }) : null
        ])
      ]);
      row.addEventListener('click', function () {
        var st = stateFor(ctx, member.id); st.index = i; st.mode = 'wizard'; ctx.render();
      });
      rows.appendChild(row);
    });
    wrap.appendChild(rows);
    wrap.appendChild(h('div', { style: 'margin-top:22px;display:flex;gap:10px' }, [
      h('button', { class: 'btn secondary', onclick: function () { ctx.navigate(null); }, text: '← Back to dashboard' }),
      allDone ? null : h('button', { class: 'btn', onclick: function () {
        var st = stateFor(ctx, member.id);
        var firstUndone = ids.findIndex(function (id) { return !byId[id].winner; });
        st.index = firstUndone < 0 ? 0 : firstUndone; st.mode = 'wizard'; ctx.render();
      }, text: 'Continue reviewing →' })
    ]));
    return wrap;
  }

  function signature(state, ctx, member) {
    var st = ctx.wizState[member.id] || { index: 0, mode: 'wizard' };
    var byId = ctx.matchesById(state);
    var phase = activePhase(state.config);
    var ids = ctx.assignmentsFor(member, phase);
    var ms = ids.map(function (id) {
      var m = byId[id];
      return m ? (m.winner || '') + (m.commentA ? 'a' : '') + (m.commentB ? 'b' : '') : 'x';
    }).join(',');
    return [member.id, phase, st.index, st.mode, ids.length, ms].join('|');
  }

  return { render: render, signature: signature };
})();
