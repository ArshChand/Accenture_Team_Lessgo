import { Router } from 'express';
import { hospitalSystems } from '../integrations/hospitalSystems.js';

/**
 * The hospital-systems boundary, exposed over HTTP.
 *
 * Every route here is a direct, read-only pass-through to the adapter in
 * `integrations/hospitalSystems.js` — there is no clinical logic in this
 * file. Bed availability and an external record lookup reach the frontend as
 * situational awareness and intake context respectively; neither is ever an
 * input the scoring pipeline reads, so an unreachable or stale hospital
 * system can never move a patient's ESI. A 502 here means "ask the hospital's
 * other system again later", not "the triage assistant is degraded".
 */
export function integrationsRoutes() {
  const router = Router();

  const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

  router.get(
    '/integrations/beds',
    asyncRoute(async (req, res) => {
      try {
        const beds = await hospitalSystems.getBedAvailability();
        res.json(beds);
      } catch (error) {
        res.status(502).json({ error: 'hospital_system_unreachable', message: error.message });
      }
    }),
  );

  router.get(
    '/integrations/his-lookup',
    asyncRoute(async (req, res) => {
      const { phone, abhaId } = req.query;
      if (!phone && !abhaId) {
        return res
          .status(400)
          .json({ error: 'missing_identifier', message: 'Provide a phone number or ABHA id to look up.' });
      }
      try {
        const record = await hospitalSystems.lookupExternalRecord({ phone, abhaId });
        return res.json({ found: Boolean(record), record });
      } catch (error) {
        return res.status(502).json({ error: 'hospital_system_unreachable', message: error.message });
      }
    }),
  );

  return router;
}
