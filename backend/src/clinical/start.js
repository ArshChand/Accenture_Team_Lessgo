import { START_CATEGORY, START_TO_ESI } from './constants.js';
import { valueOf } from './observation.js';

/**
 * START and JumpSTART — the last line of defence.
 *
 * Carried forward from the Round 1 concept: when the network drops, the model is
 * unreachable and the record is empty, triage does not stop. It falls back to a
 * protocol that needs nothing but what a person can see in thirty seconds —
 * whether the patient can walk, whether they are breathing, whether blood is
 * reaching their fingers, and whether they can follow an instruction.
 *
 * START (Simple Triage And Rapid Treatment) is the adult pathway; JumpSTART is its
 * paediatric counterpart for children under 8, and it differs in ways that matter:
 * children have a different respiratory range, and an apnoeic child with a pulse
 * gets rescue breaths before being categorised, because paediatric arrest is
 * usually respiratory in origin and is often reversible at that moment.
 *
 * One deliberate departure from field START: `expectant` maps to ESI 1, not to a
 * deprioritised category. START was designed for a mass-casualty incident where
 * resources are genuinely insufficient and the expectant category means "we cannot
 * help this person and others will die if we try". A hospital emergency department
 * is not that setting. An apnoeic patient here gets the resuscitation bay.
 */

const ADULT_PATHWAY_MIN_AGE = 8;

/**
 * @param {object} args
 * @param {number} args.ageYears
 * @param {object} args.vitals  observation-shaped vitals
 * @param {string} [args.reason] why the system degraded to this pathway
 */
export function evaluateStartProtocol({ ageYears, vitals = {}, reason }) {
  const paediatric = Number.isFinite(ageYears) && ageYears < ADULT_PATHWAY_MIN_AGE;
  return paediatric
    ? jumpStart({ ageYears, vitals, reason })
    : start({ ageYears, vitals, reason });
}

function readObservations(vitals) {
  const cues = vitals.observedCues ?? {};
  return {
    rr: valueOf(vitals.respiratoryRate),
    capRefill: valueOf(vitals.capillaryRefillSec),
    gcs: valueOf(vitals.gcs),
    avpu: valueOf(vitals.avpu),
    hr: valueOf(vitals.heartRate),
    canWalk: cues.canWalk,
    hasRadialPulse: cues.hasRadialPulse,
  };
}

/** Can the patient follow a simple instruction? */
function obeysCommands({ gcs, avpu }) {
  if (Number.isFinite(gcs)) return gcs >= 14;
  if (avpu) return avpu === 'A';
  return undefined; // genuinely unknown, which is itself a finding
}

function start({ vitals, reason }) {
  const obs = readObservations(vitals);
  const steps = [];

  // Step 1 — ambulatory patients are the walking wounded.
  if (obs.canWalk === true) {
    steps.push('Able to walk → minor');
    return result(START_CATEGORY.MINOR, 'start', steps, reason);
  }
  steps.push(obs.canWalk === false ? 'Unable to walk' : 'Ability to walk not assessed');

  // Step 2 — respirations.
  if (Number.isFinite(obs.rr)) {
    if (obs.rr === 0) {
      steps.push('Not breathing → expectant (resuscitation in a hospital setting)');
      return result(START_CATEGORY.EXPECTANT, 'start', steps, reason);
    }
    if (obs.rr > 30) {
      steps.push(`Respiratory rate ${obs.rr} > 30 → immediate`);
      return result(START_CATEGORY.IMMEDIATE, 'start', steps, reason);
    }
    steps.push(`Respiratory rate ${obs.rr} within range`);
  } else {
    // Nothing measured. START cannot clear a patient it has not observed.
    steps.push('Respiratory rate not recorded → cannot clear, defaulting to immediate');
    return result(START_CATEGORY.IMMEDIATE, 'start', steps, reason);
  }

  // Step 3 — perfusion.
  if (obs.hasRadialPulse === false) {
    steps.push('No radial pulse → immediate');
    return result(START_CATEGORY.IMMEDIATE, 'start', steps, reason);
  }
  if (Number.isFinite(obs.capRefill) && obs.capRefill > 2) {
    steps.push(`Capillary refill ${obs.capRefill}s > 2s → immediate`);
    return result(START_CATEGORY.IMMEDIATE, 'start', steps, reason);
  }
  steps.push('Perfusion adequate');

  // Step 4 — mental status.
  const obeys = obeysCommands(obs);
  if (obeys === false) {
    steps.push('Cannot follow simple commands → immediate');
    return result(START_CATEGORY.IMMEDIATE, 'start', steps, reason);
  }
  if (obeys === undefined) {
    steps.push('Mental status not assessed → cannot clear, defaulting to immediate');
    return result(START_CATEGORY.IMMEDIATE, 'start', steps, reason);
  }

  steps.push('Follows commands → delayed');
  return result(START_CATEGORY.DELAYED, 'start', steps, reason);
}

function jumpStart({ ageYears, vitals, reason }) {
  const obs = readObservations(vitals);
  const steps = [`JumpSTART pathway (age ${ageYears?.toFixed?.(1) ?? '?'} < ${ADULT_PATHWAY_MIN_AGE})`];

  if (obs.canWalk === true) {
    steps.push('Able to walk → minor');
    return result(START_CATEGORY.MINOR, 'jumpstart', steps, reason);
  }
  steps.push(obs.canWalk === false ? 'Unable to walk' : 'Ability to walk not assessed');

  // Apnoea in a child is usually respiratory in origin and often reversible, so
  // JumpSTART inserts a rescue-breath step that adult START does not have.
  if (Number.isFinite(obs.rr)) {
    if (obs.rr === 0) {
      if (obs.hasRadialPulse === false) {
        steps.push('Apnoeic with no palpable pulse → expectant (resuscitation in a hospital setting)');
        return result(START_CATEGORY.EXPECTANT, 'jumpstart', steps, reason);
      }
      steps.push('Apnoeic with a pulse → 5 rescue breaths, then immediate');
      return result(START_CATEGORY.IMMEDIATE, 'jumpstart', steps, reason);
    }
    // The paediatric range is a band, not a ceiling: too slow is as ominous as too fast.
    if (obs.rr < 15 || obs.rr > 45) {
      steps.push(`Respiratory rate ${obs.rr} outside 15-45 → immediate`);
      return result(START_CATEGORY.IMMEDIATE, 'jumpstart', steps, reason);
    }
    steps.push(`Respiratory rate ${obs.rr} within 15-45`);
  } else {
    steps.push('Respiratory rate not recorded → cannot clear, defaulting to immediate');
    return result(START_CATEGORY.IMMEDIATE, 'jumpstart', steps, reason);
  }

  if (obs.hasRadialPulse === false) {
    steps.push('No palpable pulse → immediate');
    return result(START_CATEGORY.IMMEDIATE, 'jumpstart', steps, reason);
  }
  if (Number.isFinite(obs.capRefill) && obs.capRefill > 2) {
    steps.push(`Capillary refill ${obs.capRefill}s > 2s → immediate`);
    return result(START_CATEGORY.IMMEDIATE, 'jumpstart', steps, reason);
  }
  steps.push('Perfusion adequate');

  // JumpSTART uses AVPU rather than command-following: a toddler who will not obey
  // an instruction may simply be a toddler.
  const avpu = obs.avpu;
  const gcs = obs.gcs;
  if (avpu === 'P' || avpu === 'U' || (Number.isFinite(gcs) && gcs < 13)) {
    steps.push('Responds only to pain or unresponsive → immediate');
    return result(START_CATEGORY.IMMEDIATE, 'jumpstart', steps, reason);
  }
  if (!avpu && !Number.isFinite(gcs)) {
    steps.push('Responsiveness not assessed → cannot clear, defaulting to immediate');
    return result(START_CATEGORY.IMMEDIATE, 'jumpstart', steps, reason);
  }

  steps.push('Alert or responds to voice → delayed');
  return result(START_CATEGORY.DELAYED, 'jumpstart', steps, reason);
}

function result(category, pathway, steps, reason) {
  return {
    category,
    pathway,
    steps,
    esi: START_TO_ESI[category],
    degradedReason: reason,
  };
}
