import { CONFIDENCE_BAND, ESI } from './constants.js';

/**
 * The safety ratchet: how a rule floor and a model prediction become one score.
 *
 * The whole design rests on a single invariant, asserted in the tests as a
 * property rather than trusted by reading:
 *
 *     finalESI <= min(ruleFloor, modelESI)
 *
 * Fusion can only ever make an assessment MORE urgent than what either layer
 * concluded on its own. There is no code path that produces a less urgent number
 * than the rules demanded, which is what makes the deterministic layer a genuine
 * floor rather than a suggestion the model can average away.
 *
 * That invariant is what turns "we bias toward escalation" from a claim into a
 * structural guarantee. A model regression can make the assistant noisier or less
 * useful; it cannot quietly lower a floor a clinician can read in rules.js.
 *
 * Three stages, in order:
 *
 *   1. Take the more urgent of the two layers.
 *   2. Where a hard red flag fired, record that the model was locked out. With
 *      min() this needs no separate enforcement — a red flag at ESI 2 already
 *      beats a model saying 4 — but it is recorded explicitly so the dashboard
 *      can show the nurse that a named clinical rule, not a statistical model,
 *      is holding this patient's priority.
 *   3. Escalate one further level when confidence is low, floored at ESI 2.
 */

/** Lower ESI number = more urgent. */
const moreUrgent = (a, b) => Math.min(a, b);

export function fuse({
  ruleResult,
  modelResult,
  confidence,
  protocol,
  surgeActive = false,
}) {
  const ruleFloor = ruleResult?.esi ?? ESI.NON_URGENT;
  // A missing model imposes no constraint. It must never be read as a vote for
  // ESI 5 — silence from a service is not a clinical opinion.
  const modelESI = Number.isFinite(modelResult?.esi) ? modelResult.esi : ESI.NON_URGENT;
  const modelAvailable = Number.isFinite(modelResult?.esi);

  // --- 1. the more urgent of the two layers ---
  let finalESI = moreUrgent(ruleFloor, modelESI);

  // --- 2. hard red flag provenance ---
  const hardRedFlags = (ruleResult?.firedRules ?? []).filter((rule) => rule.hardRedFlag);
  const redFlagLocked = hardRedFlags.length > 0 && ruleFloor <= modelESI;

  // --- 3. uncertainty escalation ---
  // Under surge the threshold widens: nurse attention per patient has dropped, so
  // the system compensates by escalating on less uncertainty, not more.
  const escalationThreshold = surgeActive
    ? protocol.confidence.surgeEscalationThreshold
    : protocol.confidence.thresholds.moderate;
  const escalationFloor = protocol.confidence.escalationFloorESI;

  let ratchetApplied = false;
  let escalationReason = null;
  const beforeRatchet = finalESI;

  if (
    Number.isFinite(confidence?.score) &&
    confidence.score < escalationThreshold &&
    finalESI > escalationFloor
  ) {
    finalESI = Math.max(escalationFloor, finalESI - 1);
    ratchetApplied = true;
    escalationReason =
      `Confidence ${confidence.score.toFixed(2)} is below the ` +
      `${surgeActive ? 'surge' : 'standard'} threshold of ${escalationThreshold}. ` +
      `Escalated from ESI ${beforeRatchet} to ${finalESI} rather than accepting an uncertain lower priority.` +
      (confidence.drivers?.length ? ` Driven by: ${confidence.drivers.slice(0, 2).join('; ')}.` : '');
  }

  // The invariant, enforced rather than assumed. If any future change to the logic
  // above could produce a less urgent result than either layer concluded, this
  // clamp catches it instead of letting it reach a patient.
  const ceiling = moreUrgent(ruleFloor, modelESI);
  if (finalESI > ceiling) finalESI = ceiling;

  return {
    finalESI,
    ruleFloor,
    modelESI: modelAvailable ? modelESI : null,
    ratchetApplied,
    escalationReason,
    redFlagLocked,
    escalationThreshold,
    surgeActive,
    /** Which layer determined the outcome, for the dashboard's provenance chip. */
    decidedBy: decideProvenance({ ruleFloor, modelESI, finalESI, ratchetApplied, modelAvailable }),
    hardRedFlagCodes: hardRedFlags.map((rule) => rule.code),
  };
}

function decideProvenance({ ruleFloor, modelESI, finalESI, ratchetApplied, modelAvailable }) {
  if (ratchetApplied) return 'uncertainty_escalation';
  if (!modelAvailable) return 'rules_only';
  if (ruleFloor < modelESI) return 'rule_engine';
  if (modelESI < ruleFloor) return 'model';
  return finalESI === ruleFloor ? 'both_agree' : 'model';
}

/**
 * Merge rule findings and model contributions into the flags a nurse actually
 * reads.
 *
 * Ordering is the design decision here, not the content. A triage nurse has
 * seconds and will read the top two or three items, so the list is ordered by what
 * should change her behaviour soonest: hard red flags naming a specific clinical
 * rule, then other fired rules by urgency, then the model's statistical
 * contributions, then the reasons the assistant is unsure.
 *
 * Rules come before model contributions deliberately. "Fever under 3 months
 * mandates a septic screen" is a claim she can verify and act on; "reported pain
 * contributed +0.26 toward urgent" is a description of a computation. Both belong
 * on the screen; only one of them is a reason.
 */
export function buildExplainFlags({ ruleResult, modelResult, confidence, fusion, maxModelFlags = 4 }) {
  const flags = [];

  for (const rule of ruleResult?.firedRules ?? []) {
    flags.push({
      code: rule.code,
      label: rule.label,
      severity: rule.hardRedFlag ? 'critical' : rule.severity,
      evidence: rule.evidence,
      ageBandSpecific: rule.ageBandSpecific,
      source: 'rule',
      impliedESI: rule.impliedESI,
      rationale: rule.rationale,
      hardRedFlag: rule.hardRedFlag,
    });
  }

  const contributions = (modelResult?.topContributions ?? [])
    .filter((entry) => entry.direction === 'toward_urgent')
    .slice(0, maxModelFlags);

  for (const entry of contributions) {
    flags.push({
      code: `MODEL_${entry.feature.toUpperCase()}`,
      label: entry.label ?? entry.feature,
      severity: 'info',
      evidence:
        entry.missing || entry.value === null
          ? 'not recorded'
          : `${entry.value} (contribution ${entry.contribution > 0 ? '+' : ''}${entry.contribution})`,
      source: 'model',
      ageBandSpecific: false,
    });
  }

  if (confidence?.band === CONFIDENCE_BAND.LOW) {
    flags.push({
      code: 'LOW_CONFIDENCE',
      label: fusion?.ratchetApplied
        ? 'Low confidence — escalated as a precaution'
        : 'Low confidence in this assessment',
      severity: 'warning',
      evidence: confidence.drivers?.slice(0, 3).join('; ') || `score ${confidence.score}`,
      source: 'confidence',
      ageBandSpecific: false,
    });
  }

  if (fusion?.redFlagLocked) {
    flags.push({
      code: 'RED_FLAG_LOCKED',
      label: 'Priority held by a clinical rule, not the model',
      severity: 'critical',
      evidence: `${fusion.hardRedFlagCodes.join(', ')} — the risk model cannot lower this score`,
      source: 'fusion',
      ageBandSpecific: false,
    });
  }

  const severityRank = { critical: 0, warning: 1, info: 2 };
  const sourceRank = { fusion: 0, rule: 1, confidence: 2, model: 3 };

  return flags.sort((a, b) => {
    if (a.hardRedFlag !== b.hardRedFlag) return a.hardRedFlag ? -1 : 1;
    const bySeverity = severityRank[a.severity] - severityRank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const bySource = sourceRank[a.source] - sourceRank[b.source];
    if (bySource !== 0) return bySource;
    return (a.impliedESI ?? 9) - (b.impliedESI ?? 9);
  });
}
