import { CONFIDENCE_BAND } from './constants.js';
import { modelSupportWith } from './protocol.js';
import { reliabilityOf, valueOf } from './observation.js';

/**
 * The confidence composite.
 *
 * The brief requires that no score is returned without a confidence indicator, but
 * the more important requirement is what confidence is *for*. Here it is not a
 * decoration on the score — it is an input to the score. Low confidence escalates
 * the ESI through the ratchet in fusion.js, so being unsure makes the system more
 * cautious rather than merely less emphatic.
 *
 * Four components, each answering a different question about how much the
 * assessment can be trusted:
 *
 *   completeness      did anyone actually measure this patient?
 *   modelMargin       how decided is the model between levels?
 *   inputReliability  how trustworthy is the evidence we do have?
 *   ageBandSupport    has the model seen enough patients of this age?
 *
 * They are kept separate rather than collapsed early because a nurse needs to know
 * *why* the assistant is unsure. "Low confidence" is not actionable; "no oxygen
 * saturation recorded and the history came through an attendant" is.
 */

/**
 * How much each observation contributes to a complete picture.
 *
 * Weights, not a plain count: a missing saturation matters far more than a missing
 * blood glucose. Deliberately dominated by the vitals block, because a patient with
 * a rich history and no observations has not been assessed.
 */
export const COMPLETENESS_WEIGHTS = Object.freeze({
  // Vitals — 0.72 of the total.
  spo2: 0.16,
  heartRate: 0.14,
  respiratoryRate: 0.14,
  systolicBP: 0.13,
  temperatureC: 0.09,
  gcs: 0.06,
  // Intake — 0.18.
  symptoms: 0.18,
  // Prior context — 0.10.
  priorRecord: 0.06,
  baselines: 0.04,
});

/** Human-readable names used in the "why is confidence low" list. */
const DRIVER_LABELS = {
  spo2: 'oxygen saturation',
  heartRate: 'heart rate',
  respiratoryRate: 'respiratory rate',
  systolicBP: 'blood pressure',
  temperatureC: 'temperature',
  gcs: 'conscious level',
  symptoms: 'reported symptoms',
  priorRecord: 'prior medical record',
  baselines: 'baseline observations',
};

const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * Weighted fraction of the picture that exists.
 * @returns {{ score: number, missing: string[] }}
 */
export function computeCompleteness({ vitals = {}, encounter = {}, patient = {} }) {
  const present = {
    spo2: valueOf(vitals.spo2) !== undefined,
    heartRate: valueOf(vitals.heartRate) !== undefined,
    respiratoryRate: valueOf(vitals.respiratoryRate) !== undefined,
    systolicBP: valueOf(vitals.systolicBP) !== undefined,
    temperatureC: valueOf(vitals.temperatureC) !== undefined,
    gcs: valueOf(vitals.gcs) !== undefined || valueOf(vitals.avpu) !== undefined,
    symptoms: (encounter?.intake?.extraction?.symptoms ?? []).length > 0,
    priorRecord: Boolean(patient?.hasPriorRecord),
    baselines: Object.values(patient?.baselines ?? {}).some((v) => v !== undefined && v !== null),
  };

  let score = 0;
  const missing = [];
  for (const [key, weight] of Object.entries(COMPLETENESS_WEIGHTS)) {
    if (present[key]) score += weight;
    else missing.push(key);
  }

  return { score: clamp01(score), missing };
}

/**
 * How decisively the model picked a level.
 *
 * Blends two views because either alone can mislead. The margin between the top
 * two classes catches a close two-way call; normalised entropy catches a
 * distribution that is diffuse across all five levels even when one happens to
 * lead. A model that is 30/28/22/12/8 is not confident, and the margin alone would
 * not say so loudly enough.
 */
export function computeModelMargin(classProbabilities) {
  if (!Array.isArray(classProbabilities) || classProbabilities.length < 2) {
    // No model output at all. Not zero — the rule engine still ran — but low
    // enough that a rules-only assessment leans toward escalation.
    return { score: 0.4, unavailable: true };
  }

  const sorted = [...classProbabilities].sort((a, b) => b - a);
  const margin = clamp01(sorted[0] - sorted[1]);

  const total = classProbabilities.reduce((sum, p) => sum + p, 0) || 1;
  const entropy = -classProbabilities.reduce((sum, p) => {
    const normalised = p / total;
    return sum + (normalised > 0 ? normalised * Math.log(normalised) : 0);
  }, 0);
  const decisiveness = clamp01(1 - entropy / Math.log(classProbabilities.length));

  return { score: clamp01(0.5 * margin + 0.5 * decisiveness), unavailable: false };
}

/**
 * How much the evidence can be trusted, weighted the same way completeness is.
 *
 * This is where provenance pays off. A full set of vitals measured by a monitor
 * scores near 1.0; the same numbers relayed by an attendant score around 0.45; a
 * symptom inferred from a poorly-heard Kannada sentence carries ASR × extraction
 * confidence. Same numbers, different trust, different final score.
 */
export function computeInputReliability({ vitals = {}, encounter = {} }) {
  const contributions = [
    ['spo2', reliabilityOf(vitals.spo2)],
    ['heartRate', reliabilityOf(vitals.heartRate)],
    ['respiratoryRate', reliabilityOf(vitals.respiratoryRate)],
    ['systolicBP', reliabilityOf(vitals.systolicBP)],
    ['temperatureC', reliabilityOf(vitals.temperatureC)],
    ['gcs', Math.max(reliabilityOf(vitals.gcs), reliabilityOf(vitals.avpu))],
  ].filter(([, reliability]) => reliability > 0);

  const weak = [];
  let weighted = 0;
  let weightTotal = 0;

  for (const [key, reliability] of contributions) {
    const weight = COMPLETENESS_WEIGHTS[key];
    weighted += reliability * weight;
    weightTotal += weight;
    if (reliability < 0.7) weak.push(DRIVER_LABELS[key] ?? key);
  }

  // The intake channel is evidence too: how well we heard the patient and how
  // well we understood them bounds everything derived from what they said.
  const transcripts = encounter?.intake?.transcripts ?? [];
  const extractionConfidence = encounter?.intake?.extraction?.extractionConfidence;
  if (transcripts.length > 0 || Number.isFinite(extractionConfidence)) {
    const asr = transcripts.length
      ? Math.max(...transcripts.map((t) => t.asrConfidence ?? 0.9))
      : 0.9;
    const intakeReliability = clamp01(asr * (extractionConfidence ?? 0.9));
    const intakeWeight = COMPLETENESS_WEIGHTS.symptoms;
    weighted += intakeReliability * intakeWeight;
    weightTotal += intakeWeight;
    if (intakeReliability < 0.7) weak.push('what the patient said');
  }

  if (weightTotal === 0) {
    // Nothing measured and nothing said. The weakest possible evidence state.
    return { score: 0.2, weak: ['no evidence of any kind recorded'] };
  }

  return { score: clamp01(weighted / weightTotal), weak };
}

/**
 * Build the full confidence object.
 *
 * @param {object} args
 * @param {object} args.protocol       site protocol in force (supplies weights and cut points)
 * @param {object} args.encounter
 * @param {object} args.patient
 * @param {object} args.vitals
 * @param {number[]} [args.classProbabilities] model output, absent when it is unavailable
 * @param {boolean} [args.modelUnavailable]
 * @param {string} [args.ageBand]
 */
export function computeConfidence({
  protocol,
  encounter = {},
  patient = {},
  vitals = {},
  classProbabilities,
  modelUnavailable = false,
  ageBand,
}) {
  const weights = protocol.confidence.weights;

  const completeness = computeCompleteness({ vitals, encounter, patient });
  const margin = computeModelMargin(modelUnavailable ? undefined : classProbabilities);
  const reliability = computeInputReliability({ vitals, encounter });
  const bandSupport = clamp01(modelSupportWith(protocol, ageBand ?? encounter?.age?.band));

  const score = clamp01(
    weights.completeness * completeness.score +
      weights.modelMargin * margin.score +
      weights.inputReliability * reliability.score +
      weights.ageBandSupport * bandSupport,
  );

  const { high, moderate } = protocol.confidence.thresholds;
  const band =
    score >= high
      ? CONFIDENCE_BAND.HIGH
      : score >= moderate
        ? CONFIDENCE_BAND.MODERATE
        : CONFIDENCE_BAND.LOW;

  // Why confidence is not higher — the part a nurse can act on.
  const drivers = [];
  for (const key of completeness.missing) {
    drivers.push(`No ${DRIVER_LABELS[key] ?? key} recorded`);
  }
  if (margin.unavailable) {
    drivers.push('Risk model unavailable — assessed on rules alone');
  } else if (margin.score < 0.5) {
    drivers.push('Model is undecided between severity levels');
  }
  for (const source of reliability.weak) {
    drivers.push(`Low reliability: ${source}`);
  }
  if (bandSupport < 0.7) {
    drivers.push(
      `Thin training coverage for the ${ageBand ?? encounter?.age?.band ?? 'this'} age band`,
    );
  }
  if (encounter?.intake?.viaProxy) {
    drivers.push('History given by an attendant rather than the patient');
  }

  return {
    score: Number(score.toFixed(3)),
    band,
    components: {
      completeness: Number(completeness.score.toFixed(3)),
      modelMargin: Number(margin.score.toFixed(3)),
      inputReliability: Number(reliability.score.toFixed(3)),
      ageBandSupport: Number(bandSupport.toFixed(3)),
    },
    drivers,
  };
}
