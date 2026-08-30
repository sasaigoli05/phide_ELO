/*
 * parse.js — turn the uploaded template workbook into candidates + committee.
 *
 * Environment-agnostic: takes an already-loaded SheetJS workbook object, so it
 * works the same in the browser (XLSX.read) and in Node (XLSX.readFile) for tests.
 *
 * The "Responses" sheet is a Google Forms export. We only scrape the columns the
 * platform needs and match them by header *text* (not fixed position) so a slightly
 * different export still works.
 */
(function (global) {
  'use strict';

  // The five application essays, matched by the leading "1." .. "5." in the header.
  // Order here is the order they appear in the wizard.
  var ESSAY_ORDER = ['1', '2', '3', '4', '5'];

  function norm(s) {
    return (s == null ? '' : String(s)).trim();
  }
  function lc(s) {
    return norm(s).toLowerCase();
  }

  // Find the index of the first header that satisfies `test`.
  function findCol(headers, test) {
    for (var i = 0; i < headers.length; i++) {
      if (test(lc(headers[i]), i)) return i;
    }
    return -1;
  }

  /*
   * Google Drive share links come in a few shapes:
   *   https://drive.google.com/file/d/FILEID/view?usp=sharing
   *   https://drive.google.com/open?id=FILEID
   *   https://drive.google.com/uc?id=FILEID
   * Convert any of them to a direct-view thumbnail URL that <img> can render,
   * *if* the file is shared "anyone with the link". Returns '' if not a Drive link.
   */
  function driveToImage(url) {
    var u = norm(url);
    if (!u) return '';
    var id = '';
    var m = u.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    if (m) id = m[1];
    if (!id) {
      m = u.match(/[?&]id=([A-Za-z0-9_-]+)/);
      if (m) id = m[1];
    }
    if (!id) {
      // Not a recognizable Drive link — if it already looks like an image URL, keep it.
      if (/^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?|$)/i.test(u)) return u;
      return '';
    }
    // thumbnail endpoint is the most reliable for hotlinking Drive images
    return 'https://drive.google.com/thumbnail?id=' + id + '&sz=w600';
  }

  function parseCandidates(wb) {
    // Prefer a sheet literally named "Responses", else the first sheet.
    var sheetName = wb.SheetNames.indexOf('Responses') >= 0 ? 'Responses' : wb.SheetNames[0];
    var ws = wb.Sheets[sheetName];
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
    if (!rows.length) return [];

    var headers = rows[0].map(norm);

    var col = {
      // Matches "Name (First, Last)" (current form) and "Personal Information - Full Name"
      // (older template) alike — anything with "name" that isn't the phonetic column.
      name: findCol(headers, function (h) { return h.indexOf('name') >= 0 && h.indexOf('phonetic') < 0; }),
      phonetic: findCol(headers, function (h) { return h.indexOf('phonetic') >= 0; }),
      majors: findCol(headers, function (h) { return h.indexOf('major') >= 0; }),
      minors: findCol(headers, function (h) { return h.indexOf('minor') >= 0; }),
      year: findCol(headers, function (h) { return h.indexOf('year') >= 0; }),
      photo: findCol(headers, function (h) { return h.indexOf('picture') >= 0 || h.indexOf('photo') >= 0; }),
      // The "list your top 1-5 achievements/experiences" free-text question. Matched by
      // its distinctive opening phrase rather than a fixed column position, since its
      // exact wording/position can shift between form versions.
      achievements: findCol(headers, function (h) { return h.indexOf('make your list') >= 0; })
    };

    // Essay columns: header begins with "N." (with any leading whitespace).
    var essayCols = {};
    ESSAY_ORDER.forEach(function (n) {
      essayCols[n] = findCol(headers, function (h) {
        return new RegExp('^' + n + '\\s*\\.').test(h);
      });
    });

    var candidates = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var name = col.name >= 0 ? norm(row[col.name]) : '';
      if (!name) continue; // skip blank rows

      var essays = [];
      ESSAY_ORDER.forEach(function (n) {
        var ci = essayCols[n];
        if (ci >= 0) {
          essays.push({
            q: headers[ci],                 // full question text, shown as the box label
            a: norm(row[ci])                // the applicant's answer
          });
        }
      });
      if (col.achievements >= 0) {
        essays.push({
          q: 'Notable achievements & experience (self-ranked list)',
          a: norm(row[col.achievements])
        });
      }

      var rawPhoto = col.photo >= 0 ? norm(row[col.photo]) : '';
      candidates.push({
        id: 'c' + candidates.length,
        name: name,
        phonetic: col.phonetic >= 0 ? norm(row[col.phonetic]) : '',
        majors: col.majors >= 0 ? norm(row[col.majors]) : '',
        minors: col.minors >= 0 ? norm(row[col.minors]) : '',
        year: col.year >= 0 ? norm(row[col.year]) : '',
        photoRaw: rawPhoto,
        photo: driveToImage(rawPhoto),
        essays: essays,
        // running Elo state (seeded here, updated by elo.js)
        elo: 1500,
        wins: 0,
        losses: 0
      });
    }
    return candidates;
  }

  function parseCommittee(wb) {
    // Look for a sheet whose name mentions "committee", else the second sheet.
    var name = null;
    wb.SheetNames.forEach(function (n) {
      if (n.toLowerCase().indexOf('committee') >= 0) name = n;
    });
    if (!name) name = wb.SheetNames[1];
    if (!name) return [];

    var ws = wb.Sheets[name];
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });

    var members = [];
    rows.forEach(function (row) {
      // The template has an index in col A and the name in col B, plus a header row.
      // Scan every cell; take the first non-numeric, non-header text as the name.
      for (var c = 0; c < row.length; c++) {
        var v = norm(row[c]);
        if (!v) continue;
        if (/^\d+(\.0+)?$/.test(v)) continue;                 // "1", "1.0" index cells
        if (v.toUpperCase().indexOf('LIST COMMITTEE') >= 0) return; // header cell -> skip row
        if (v.length < 2) continue;
        members.push({
          id: 'm' + members.length,
          name: v,
          phase1Done: false,
          phase2Done: false,
          phase1: [],   // ordered list of match ids assigned in phase 1
          phase2: []    // ordered list of match ids assigned in phase 2
        });
        return; // one member per row
      }
    });
    return members;
  }

  function parseTemplate(wb) {
    return {
      candidates: parseCandidates(wb),
      committee: parseCommittee(wb)
    };
  }

  var api = {
    parseTemplate: parseTemplate,
    parseCandidates: parseCandidates,
    parseCommittee: parseCommittee,
    driveToImage: driveToImage
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Parse = api;
})(typeof window !== 'undefined' ? window : globalThis);
