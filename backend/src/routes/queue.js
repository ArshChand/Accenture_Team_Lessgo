import { Router } from 'express';
import { repositories } from '../db/index.js';
import { WAITING_STATUSES } from '../services/triageService.js';

/**
 * HTTP polling fallback for the live queue.
 *
 * Socket.IO is the primary channel — see realtime/socket.js — but the brief is
 * explicit that hospitals differ hugely in technical maturity, and a rural
 * department on a flaky connection must still see its queue. The frontend's
 * `useQueue` hook falls back to polling this route on socket failure, at the
 * same interval the engine ticks, so the two channels present identical data.
 *
 * `since` is an ISO timestamp; only encounters touched at or after it are
 * returned, so a client that already has the full queue only pulls the diff.
 * Omit it for the initial load.
 */
export function queueRoutes() {
  const router = Router();

  router.get('/queue', async (req, res, next) => {
    try {
      const filter = { status: { $in: WAITING_STATUSES } };
      if (req.query.since) {
        const since = new Date(req.query.since);
        if (!Number.isNaN(since.getTime())) filter.updatedAt = { $gte: since };
      }

      const encounters = await repositories.encounters.find(filter, {
        sort: { 'queue.priorityScore': -1, arrivalAt: 1 },
      });

      // Capacity debt travels with the snapshot as well as with socket patches.
      // Without it a client that has only done the initial load would have to
      // render 0 — a confident-looking number whose real meaning is "not known
      // yet", which is precisely the kind of false authority this system exists
      // to avoid.
      const capacityDebtMinutes = Math.round(
        encounters.reduce((sum, encounter) => {
          const { decayStatus, safeWaitMinutes, decayRatio } = encounter.queue ?? {};
          if (decayStatus !== 'red' || !Number.isFinite(safeWaitMinutes)) return sum;
          const waited = (decayRatio ?? 0) * safeWaitMinutes;
          return sum + Math.max(0, waited - safeWaitMinutes);
        }, 0),
      );

      res.json({
        encounters,
        count: encounters.length,
        capacityDebtMinutes,
        cursor: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
