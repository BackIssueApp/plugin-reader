// Panel-layout database browser (Panel Studio's "Database" view): one
// read-only route over every stored page layout. Lives in its own module so
// the route contract — the permission gate and the query/paging behaviour —
// is testable without booting the whole plugin.

/** GET /api/reader/panels/db?filter=all|ml|classical|edited|reviewed|pagemode
 *  [&q=text&offset=0&limit=50] → { total, counts, rows } (see store.panelsDb
 *  for the row shape). `access` is the same reader.panels.edit permission the
 *  rest of Panel Studio's routes use; core enforces it before the handler. */
export function registerPanelsDbRoute(api, store, access) {
  api.registerRoute('get', '/api/reader/panels/db', (req, res) => {
    try {
      res.json(store.panelsDb({
        filter: typeof req.query.filter === 'string' ? req.query.filter : 'all',
        q: typeof req.query.q === 'string' ? req.query.q : '',
        offset: Number(req.query.offset) || 0,
        limit: Number(req.query.limit) || 50,
      }));
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  }, { access });
}
