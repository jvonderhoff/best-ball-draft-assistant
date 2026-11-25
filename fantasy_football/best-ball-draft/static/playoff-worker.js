/* Playoff recommender worker: runs PlayoffRec off the page's main thread.
 *
 * Why: DK's playoff drafts are 30-second fast drafts (rules page), and the
 * table only settles at 24 simulated drafts (templates/playoff.html, REFINE_TO).
 * One at a time on the main thread that was ~13 s at pick 1 on the Mac, plus a
 * ~5 s field build on the first pick, and a phone is slower: a pick could time
 * out before the table settled (the user, 2026-11-25). The 24 drafts are
 * independent (seed 1000+k each, merged by PlayoffRec.mergeRuns), so the page
 * hands them to a pool of these workers and they run side by side.
 *
 * Results are the same numbers as the main-thread path: the worker gets the
 * page's own ctx, worlds and ADP by structured clone, and recommend() with
 * completions 1, seed s is exactly the s-th completion the page ran before.
 *
 * Messages (each carries `id`, answered with the same `id`):
 *   {type:'init', scripts:[url, url], ctx, worlds, adp}
 *   {type:'adp', adp}                       new ADP; the field is dropped
 *   {type:'buildField', format}             -> {field}; also kept here
 *   {type:'field', field}                   a field built by another worker
 *   {type:'rec', format, board, avoid:[team], include:[idx], seed} -> {run}
 */
'use strict';
let ctx = null, worlds = null, adp = null, field = null;

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      // Versioned URLs from the page, so a deploy cannot pair a new page with an
      // old cached simulator (app.py, asset()).
      importScripts(...m.scripts);
      ctx = m.ctx; worlds = m.worlds; adp = m.adp; field = null;
      self.postMessage({ id: m.id });
    } else if (m.type === 'adp') {
      adp = m.adp; field = null;
      self.postMessage({ id: m.id });
    } else if (m.type === 'buildField') {
      field = PlayoffRec.buildField(ctx, worlds, adp, m.format);
      self.postMessage({ id: m.id, field });
    } else if (m.type === 'field') {
      field = m.field;
      self.postMessage({ id: m.id });
    } else if (m.type === 'rec') {
      if (!field) throw new Error('no field in this worker');
      const av = new Set(m.avoid || []);
      const run = PlayoffRec.recommend(ctx, worlds, adp, field, m.format, m.board, {
        allow: av.size ? i => !av.has(ctx.players[i].team) : undefined,
        include: m.include, completions: 1, seed: m.seed,
      });
      self.postMessage({ id: m.id, run });
    } else {
      throw new Error('unknown message ' + m.type);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.stack) || err) });
  }
};
