/*
 * export.js — build the final downloadable workbook once Phase 2 is complete.
 *
 *   Sheet "Rankings": one row per applicant, sorted best-first by final Elo, with
 *                     record, major/minor/year, and whether they made the Phase-2 cut.
 *   Sheet "Comments": one row per comment left by a reviewer — applicant, the comment,
 *                     who wrote it, which phase, and the opponent in that matchup.
 *                     (This long format is far easier to skim in deliberation than
 *                     one-column-per-comment; every comment is captured.)
 */
(function (global) {
  'use strict';

  function buildWorkbook(candidates, matches, committeeMembers) {
    var memberName = {};
    (committeeMembers || []).forEach(function (m) { memberName[m.id] = m.name; });
    var candById = {};
    candidates.forEach(function (c) { candById[c.id] = c; });

    // Final standings across ALL matches (both phases).
    var standings = Elo.computeStandings(candidates, matches, { kFactor: 32 });

    // who played in phase 2 == "made the cut"
    var madeCut = {};
    matches.forEach(function (m) {
      if (m.phase === 2) { madeCut[m.a] = true; madeCut[m.b] = true; }
    });

    // ----- Rankings sheet -----
    var ranked = candidates.slice().sort(function (a, b) {
      return standings[b.id].elo - standings[a.id].elo;
    });
    var rankRows = [[
      'Rank', 'Full Name', 'Final Elo', 'Wins', 'Losses', 'Record',
      'Made Phase 2 Cut', 'Major(s)', 'Minor(s)', 'Year'
    ]];
    ranked.forEach(function (c, i) {
      var s = standings[c.id];
      rankRows.push([
        i + 1,
        c.name,
        Math.round(s.elo),
        s.wins,
        s.losses,
        s.wins + '-' + s.losses,
        madeCut[c.id] ? 'Yes' : 'No',
        c.majors || '',
        c.minors || '',
        c.year || ''
      ]);
    });

    // ----- Comments sheet -----
    var commentRows = [['Applicant', 'Comment', 'Written By', 'Phase', 'Opponent In Matchup']];
    matches.forEach(function (m) {
      var author = memberName[m.reviewerId] || m.reviewerId || '';
      var aName = (candById[m.a] || {}).name || m.a;
      var bName = (candById[m.b] || {}).name || m.b;
      if (m.commentA && m.commentA.trim()) {
        commentRows.push([aName, m.commentA.trim(), author, m.phase, bName]);
      }
      if (m.commentB && m.commentB.trim()) {
        commentRows.push([bName, m.commentB.trim(), author, m.phase, aName]);
      }
    });
    if (commentRows.length === 1) commentRows.push(['(no comments were left)', '', '', '', '']);

    var wb = XLSX.utils.book_new();
    var wsRank = XLSX.utils.aoa_to_sheet(rankRows);
    wsRank['!cols'] = [{ wch: 6 }, { wch: 24 }, { wch: 10 }, { wch: 7 }, { wch: 7 }, { wch: 9 }, { wch: 16 }, { wch: 20 }, { wch: 18 }, { wch: 12 }];
    var wsCom = XLSX.utils.aoa_to_sheet(commentRows);
    wsCom['!cols'] = [{ wch: 24 }, { wch: 60 }, { wch: 20 }, { wch: 7 }, { wch: 24 }];
    XLSX.utils.book_append_sheet(wb, wsRank, 'Rankings');
    XLSX.utils.book_append_sheet(wb, wsCom, 'Comments');
    return wb;
  }

  function download(candidates, matches, committeeMembers, filename) {
    var wb = buildWorkbook(candidates, matches, committeeMembers);
    XLSX.writeFile(wb, filename || 'PhiDE-Rush-Results.xlsx');
  }

  var api = { buildWorkbook: buildWorkbook, download: download };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ExportXlsx = api;
})(typeof window !== 'undefined' ? window : globalThis);
