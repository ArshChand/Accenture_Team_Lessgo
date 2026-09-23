import { Router } from 'express';
import { adjustStock, restock } from '../operations/inventory.js';
import { buildResourceOverview } from '../operations/overview.js';

/**
 * Operations intelligence over HTTP: inventory, forecast demand, shortages and
 * recommendations. Nothing here can reach a patient's score.
 */
export function resourcesRoutes() {
  const router = Router();

  const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

  router.get(
    '/resources/overview',
    asyncRoute(async (req, res) => {
      res.json(await buildResourceOverview());
    }),
  );

  router.post(
    '/resources/inventory/:resourceId/adjust',
    asyncRoute(async (req, res) => {
      const delta = Number(req.body?.delta);
      const result = adjustStock(req.params.resourceId, delta, {
        reason: req.body?.reason,
        by: req.get('x-workstation'),
      });
      res.json(result);
    }),
  );

  router.post(
    '/resources/inventory/:resourceId/restock',
    asyncRoute(async (req, res) => {
      res.json(restock(req.params.resourceId, { by: req.get('x-workstation') }));
    }),
  );

  return router;
}
