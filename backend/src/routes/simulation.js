import { Router } from 'express';
import { repositories } from '../db/index.js';
import { WAITING_STATUSES } from '../services/triageService.js';

/**
 * Demo-only time control.
 *
 * Queue decay is the centre of this system, and it plays out over 30 to 120
 * minutes of real waiting. That is exactly right clinically and useless for a
 * five-minute demonstration, so this route rewinds arrival timestamps to let a
 * reviewer watch a queue age, breach and self-escalate in seconds.
 *
 * It is deliberately quarantined rather than folded into the normal API:
 *
 *   - it lives behind ALLOW_SIMULATION, which a production deployment leaves unset
 *   - it only moves *clock* fields, and only backwards, so it cannot invent
 *     clinical findings or change anyone's score directly — everything that
 *     follows is the real engine reacting to an older timestamp
 *   - every response says plainly that simulated time was applied
 *
 * The distinction matters: nothing here fakes a triage outcome. It fakes the
 * passage of time and lets the genuine decay, re-triage and alerting logic run.
 */
export function simulationRoutes({ enabled }) {
  const router = Router();

  router.use('/simulate', (req, res, next) => {
    if (!enabled) {
      return res.status(404).json({
        error: 'simulation_disabled',
        message: 'Simulation endpoints are disabled. Set ALLOW_SIMULATION=true in a demo environment.',
      });
    }
    return next();
  });

  /**
   * Rewind the clock for waiting encounters by `minutes`, so the next engine tick
   * sees them as having waited that much longer.
   */
  router.post('/simulate/advance-time', async (req, res, next) => {
    try {
      const minutes = Number(req.body?.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return res.status(400).json({ error: 'invalid_minutes', message: 'minutes must be a positive number' });
      }

      const filter = { status: { $in: WAITING_STATUSES } };
      if (req.body?.encounterId) filter._id = req.body.encounterId;

      const encounters = await repositories.encounters.find(filter);
      const shiftMs = minutes * 60000;
      const shifted = [];

      for (const encounter of encounters) {
        const updates = {
          arrivalAt: new Date(new Date(encounter.arrivalAt).getTime() - shiftMs),
        };
        // Both clocks move together, or a rewind would look like brand-new
        // information had just arrived and reset the decay it was meant to create.
        if (encounter.queue?.lastInformedAt) {
          updates['queue.lastInformedAt'] = new Date(
            new Date(encounter.queue.lastInformedAt).getTime() - shiftMs,
          );
        }
        if (encounter.queue?.lastReassessedAt) {
          updates['queue.lastReassessedAt'] = new Date(
            new Date(encounter.queue.lastReassessedAt).getTime() - shiftMs,
          );
        }
        if (encounter.queue?.reassessmentDueAt) {
          updates['queue.reassessmentDueAt'] = new Date(
            new Date(encounter.queue.reassessmentDueAt).getTime() - shiftMs,
          );
        }

        await repositories.encounters.updateById(encounter._id, updates);
        shifted.push(encounter.displayRef);
      }

      return res.json({
        simulated: true,
        note: 'Clock fields were rewound. All resulting triage behaviour is produced by the real engine.',
        minutesAdvanced: minutes,
        encountersShifted: shifted.length,
        displayRefs: shifted,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
