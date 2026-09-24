import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config/index.js';

export const STAFF_ROLES = {
  nurse: { label: 'Nurse / triage staff' },
  ed_head: { label: 'ED head' },
};

const matches = (given, expected) => {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Which dashboard a device may open. A 4-digit PIN stands in for badge tap-in:
 * a login screen is the wrong thing to put between a nurse and a deteriorating
 * patient. This decides the view only — it is not API authentication, which a
 * real deployment adds per route alongside SSO. The patient kiosk needs no PIN.
 */
export function staffRoutes() {
  const router = Router();

  router.post('/staff/session', (req, res) => {
    const { role, pin } = req.body ?? {};
    if (!STAFF_ROLES[role]) {
      return res.status(400).json({ error: 'unknown_role', message: `Role must be one of: ${Object.keys(STAFF_ROLES).join(', ')}.` });
    }
    if (!matches(pin, config.staffPins[role])) {
      return res.status(401).json({ error: 'incorrect_pin', message: 'That PIN is not right. Try again.' });
    }
    return res.json({ role, label: STAFF_ROLES[role].label });
  });

  return router;
}
