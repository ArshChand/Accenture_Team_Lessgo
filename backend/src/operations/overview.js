import { repositories } from '../db/index.js';
import { CLINICIAN_ROLE } from '../clinical/constants.js';
import { getActiveProtocol } from '../services/protocolService.js';
import { WAITING_STATUSES } from '../services/triageService.js';
import { snapshot } from './inventory.js';
import {
  DISPLAY_FLOOR,
  buildRecommendations,
  buildShortageTable,
  forecastDemand,
  predictResources,
} from './resources.js';

/** Resource prediction for one encounter, from its standing ESI and latest assessment. */
export function predictForEncounter(encounter, assessment) {
  return predictResources({
    esi: encounter.currentESI,
    firedRules: assessment?.ruleEngine?.firedRules ?? [],
    symptoms: encounter.intake?.extraction?.symptoms ?? [],
  }).filter((prediction) => prediction.likelihood >= DISPLAY_FLOOR);
}

/**
 * Everything the Resources view shows, computed from the live queue on request.
 *
 * Predictions are derived rather than stored, so they always follow the patient's
 * current ESI — a re-triage moves the forecast on the next read with nothing to
 * keep in sync.
 */
export async function buildResourceOverview() {
  const protocol = getActiveProtocol();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [waiting, nursesOnDuty, arrivalsPerHour, inventory] = await Promise.all([
    repositories.encounters.find({ status: { $in: WAITING_STATUSES } }),
    repositories.clinicians.count({
      active: true,
      role: { $in: [CLINICIAN_ROLE.TRIAGE_NURSE, CLINICIAN_ROLE.CHARGE_NURSE] },
    }),
    repositories.encounters.count({ arrivalAt: { $gte: oneHourAgo } }),
    snapshot(),
  ]);

  const patients = await Promise.all(
    waiting.map(async (encounter) => {
      const assessment = encounter.latestAssessmentRef
        ? await repositories.assessments.findById(encounter.latestAssessmentRef)
        : null;
      return {
        displayRef: encounter.displayRef,
        firedRules: assessment?.ruleEngine?.firedRules ?? [],
        predictions: predictForEncounter(encounter, assessment),
      };
    }),
  );

  const forecast = forecastDemand(patients);
  const shortages = buildShortageTable(inventory, forecast);

  // The same test the queue engine's surge detector applies, evaluated on the
  // current numbers. Used only to gate the diversion recommendation.
  const { baselineArrivalsPerHour, surgeMultiplier, queuePerNurseThreshold } = protocol.surge;
  const queuePerNurse = waiting.length / Math.max(1, nursesOnDuty);
  const arrivalMultiple = baselineArrivalsPerHour > 0 ? arrivalsPerHour / baselineArrivalsPerHour : 0;
  const load = {
    queueDepth: waiting.length,
    nursesOnDuty,
    queuePerNurseThreshold,
    surgeConditions: arrivalMultiple >= surgeMultiplier || queuePerNurse >= queuePerNurseThreshold,
  };

  return {
    asOf: new Date().toISOString(),
    basis: { waitingPatients: waiting.length, nursesOnDuty, surgeConditions: load.surgeConditions },
    inventory,
    forecast,
    shortages,
    recommendations: buildRecommendations({ shortages, patients, load }),
  };
}
