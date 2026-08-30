import { Router } from 'express';
import { repositories } from '../db/index.js';
import {
  ENCOUNTER_STATUS,
  OVERRIDE_REASONS,
  PROMOTION_REASONS,
  TRIAGE_TRIGGER,
  resolveAgeBand,
} from '../clinical/constants.js';
import { getActiveProtocol } from '../services/protocolService.js';
import {
  CLEARING_STATUSES,
  DISPOSITION_MIN_REASON_LENGTH,
  PROMOTION_MIN_REASON_LENGTH,
  applyDisposition,
  applyOverride,
  applyQueuePromotion,
  scoreAndPersist,
} from '../services/triageService.js';
import { extractSymptoms, fetchModelInfo } from '../services/mlClient.js';
import { recordPhiAccess, verifyAuditChain } from '../services/auditService.js';
import { safeWaitMinutesWith } from '../clinical/protocol.js';

/**
 * HTTP surface for triage.
 *
 * Two things are deliberately absent. There is no route that writes an ESI
 * without producing an assessment, and there is no route that changes a score
 * without writing an audit event — the two are one operation in the service layer
 * and no endpoint can separate them.
 */
export function triageRoutes() {
  const router = Router();

  const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

  /** Session context for audit records. A deployment would take this from SSO. */
  const sessionFrom = (req) => ({
    sessionId: req.get('x-session-id'),
    workstation: req.get('x-workstation'),
    ipAddress: req.ip,
  });

  // ------------------------------------------------------- patients & staff

  router.post(
    '/patients',
    asyncRoute(async (req, res) => {
      const patient = await repositories.patients.create(req.body);
      return res.status(201).json({ patient });
    }),
  );

  router.get(
    '/patients',
    asyncRoute(async (req, res) => {
      // Identity is stripped by default: the queue does not need a name, and
      // handing one out on a list endpoint would make the access log meaningless.
      const patients = await repositories.patients.find({}, { limit: Number(req.query.limit ?? 100) });
      return res.json({
        patients: patients.map(({ identity, ...rest }) => rest),
        count: patients.length,
      });
    }),
  );

  router.post(
    '/clinicians',
    asyncRoute(async (req, res) => {
      const clinician = await repositories.clinicians.create(req.body);
      return res.status(201).json({ clinician });
    }),
  );

  router.get(
    '/clinicians',
    asyncRoute(async (req, res) => {
      const clinicians = await repositories.clinicians.find({ active: true });
      return res.json({ clinicians, count: clinicians.length });
    }),
  );

  // ------------------------------------------------------------------ intake

  router.post(
    '/encounters',
    asyncRoute(async (req, res) => {
      const { patientRef, ageYears, chiefComplaint, mode, transcripts = [], viaProxy = false, zone } = req.body;

      const patient = await repositories.patients.findById(patientRef);
      if (!patient) return res.status(404).json({ error: 'patient_not_found' });

      // Extract symptoms from whatever the patient actually said, in whatever
      // language they said it in. Failure here is not fatal — an encounter with no
      // extracted symptoms still gets scored, just with lower confidence.
      let extraction;
      for (const transcript of transcripts) {
        const result = await extractSymptoms({
          text: transcript.rawText,
          language: transcript.language,
          asrConfidence: transcript.asrConfidence ?? 0.9,
        });
        if (!result.ok) continue;
        extraction = {
          symptoms: [...new Set([...(extraction?.symptoms ?? []), ...result.data.symptoms])],
          negations: [...new Set([...(extraction?.negations ?? []), ...result.data.negations])],
          onsetHours: result.data.onsetHours ?? extraction?.onsetHours,
          severityWords: [...new Set([...(extraction?.severityWords ?? []), ...result.data.severityWords])],
          extractionConfidence: Math.min(
            extraction?.extractionConfidence ?? 1,
            result.data.extractionConfidence,
          ),
          unmappedTerms: [...new Set([...(extraction?.unmappedTerms ?? []), ...result.data.unmappedTerms])],
        };
      }

      const age = Number.isFinite(ageYears) ? ageYears : patient.ageYears;
      const encounter = await repositories.encounters.create({
        patientRef: patient._id,
        displayRef: patient.displayRef,
        age: { ageYears: age, band: resolveAgeBand(age) },
        chiefComplaint,
        mode,
        zone,
        intake: { transcripts, extraction, viaProxy, completedAt: new Date() },
        status: ENCOUNTER_STATUS.WAITING,
      });

      return res.status(201).json({ encounter });
    }),
  );

  router.get(
    '/encounters',
    asyncRoute(async (req, res) => {
      const filter = req.query.status ? { status: req.query.status } : {};
      const encounters = await repositories.encounters.find(filter, {
        sort: { 'queue.priorityScore': -1, arrivalAt: 1 },
        limit: Number(req.query.limit ?? 100),
      });
      return res.json({ encounters, count: encounters.length });
    }),
  );

  router.get(
    '/encounters/:id',
    asyncRoute(async (req, res) => {
      const encounter = await repositories.encounters.findById(req.params.id);
      if (!encounter) return res.status(404).json({ error: 'encounter_not_found' });

      const assessments = await repositories.assessments.find(
        { encounterRef: encounter._id },
        { sort: { sequence: -1 } },
      );
      const vitals = await repositories.vitals.find(
        { encounterRef: encounter._id },
        { sort: { recordedAt: -1 } },
      );

      return res.json({ encounter, assessments, vitals });
    }),
  );

  // ----------------------------------------------------------------- vitals

  router.post(
    '/encounters/:id/vitals',
    asyncRoute(async (req, res) => {
      const encounter = await repositories.encounters.findById(req.params.id);
      if (!encounter) return res.status(404).json({ error: 'encounter_not_found' });

      const vitals = await repositories.vitals.create({
        ...req.body,
        encounterRef: encounter._id,
        patientRef: encounter.patientRef,
        recordedAt: new Date(),
      });

      await repositories.encounters.updateById(encounter._id, { latestVitalsRef: vitals._id });

      // New observations are a re-triage trigger: this is how deterioration in the
      // waiting room gets caught rather than waiting for someone to notice.
      const scored = await scoreAndPersist({
        encounter: { ...encounter, latestVitalsRef: vitals._id },
        vitals,
        trigger: TRIAGE_TRIGGER.VITALS_CHANGE,
      });

      return res.status(201).json({ vitals, assessment: scored.assessment, encounter: scored.encounter });
    }),
  );

  // ---------------------------------------------------------------- scoring

  router.post(
    '/encounters/:id/score',
    asyncRoute(async (req, res) => {
      const encounter = await repositories.encounters.findById(req.params.id);
      if (!encounter) return res.status(404).json({ error: 'encounter_not_found' });

      const { assessment, fusion } = await scoreAndPersist({
        encounter,
        trigger: req.body?.trigger ?? TRIAGE_TRIGGER.NURSE_REQUEST,
        surgeActive: Boolean(req.body?.surgeActive),
      });

      return res.json({
        esi: assessment.fusion.finalESI,
        confidence: assessment.confidence,
        explainFlags: assessment.explainFlags,
        fusion,
        mode: assessment.mode,
        safeWaitMinutes: safeWaitMinutesWith(getActiveProtocol(), assessment.fusion.finalESI),
        assessmentId: assessment._id,
        latencyMs: assessment.latencyMs,
      });
    }),
  );

  // --------------------------------------------------------------- override

  router.get('/override/reasons', (req, res) => {
    res.json({
      reasons: OVERRIDE_REASONS,
      // The asymmetry, published so a client can render the right form without
      // having to encode the policy itself.
      friction: {
        escalation: { reasonCodeRequired: true, reasonTextRequired: false, attestationRequired: false },
        deEscalation: {
          reasonCodeRequired: true,
          reasonTextRequired: true,
          minReasonLength: 20,
          attestationRequired: true,
          attestationText: 'I have physically assessed this patient.',
        },
      },
    });
  });

  router.post(
    '/encounters/:id/override',
    asyncRoute(async (req, res) => {
      const { clinicianId, newESI, reasonCode, reasonText, assessmentAttested } = req.body;

      const result = await applyOverride({
        encounterId: req.params.id,
        clinicianId,
        newESI,
        reasonCode,
        reasonText,
        assessmentAttested,
        session: sessionFrom(req),
      });

      return res.json({
        encounter: result.encounter,
        previousESI: result.previousESI,
        newESI: result.newESI,
        auditSeq: result.auditEvent.seq,
        auditHash: result.auditEvent.hash,
      });
    }),
  );

  // ----------------------------------------------------------- disposition

  /**
   * Clearing a patient off the active queue.
   *
   * Deliberately not a PATCH on the encounter: a generic field-update endpoint
   * would let a caller change `status` without the audit event and the reason
   * check that belong to it. Disposition is its own named act.
   */
  router.get('/disposition/options', (req, res) => {
    res.json({
      statuses: CLEARING_STATUSES,
      friction: {
        [ENCOUNTER_STATUS.IN_TREATMENT]: { reasonTextRequired: false },
        [ENCOUNTER_STATUS.DISCHARGED]: {
          reasonTextRequired: 'when_high_acuity',
          minReasonLength: DISPOSITION_MIN_REASON_LENGTH,
          note: 'Required when the assistant still scores the patient ESI 1 or 2.',
        },
        [ENCOUNTER_STATUS.LEFT_WITHOUT_BEING_SEEN]: {
          reasonTextRequired: true,
          minReasonLength: DISPOSITION_MIN_REASON_LENGTH,
        },
      },
    });
  });

  router.post(
    '/encounters/:id/disposition',
    asyncRoute(async (req, res) => {
      const { clinicianId, status, reasonText } = req.body ?? {};

      const result = await applyDisposition({
        encounterId: req.params.id,
        clinicianId,
        status,
        reasonText,
        session: sessionFrom(req),
      });

      return res.json({
        encounter: result.encounter,
        status: result.encounter.status,
        waitedMinutes: result.waitedMinutes,
        auditSeq: result.auditEvent.seq,
        auditHash: result.auditEvent.hash,
      });
    }),
  );

  // -------------------------------------------------------------- promotion

  router.get('/promotion/reasons', (req, res) => {
    res.json({
      reasons: PROMOTION_REASONS,
      friction: {
        promote: { reasonCodeRequired: true, reasonTextRequired: false },
        release: { reasonTextRequired: true, minReasonLength: PROMOTION_MIN_REASON_LENGTH },
      },
      // Published so a client cannot present this as something it is not.
      note: 'Promotion changes queue position only. The recorded ESI is unchanged.',
    });
  });

  router.post(
    '/encounters/:id/promote',
    asyncRoute(async (req, res) => {
      const { clinicianId, reasonCode, reasonText, release } = req.body ?? {};

      const result = await applyQueuePromotion({
        encounterId: req.params.id,
        clinicianId,
        reasonCode,
        reasonText,
        release: Boolean(release),
        session: sessionFrom(req),
      });

      return res.json({
        encounter: result.encounter,
        promoted: result.promoted,
        priorityScore: result.priorityScore,
        auditSeq: result.auditEvent.seq,
        auditHash: result.auditEvent.hash,
      });
    }),
  );

  // ------------------------------------------------------------------ audit

  router.get(
    '/audit',
    asyncRoute(async (req, res) => {
      const filter = {};
      if (req.query.encounterRef) filter['subject.encounterRef'] = req.query.encounterRef;
      if (req.query.eventType) filter.eventType = req.query.eventType;

      const events = await repositories.auditEvents.find(filter, {
        sort: { seq: -1 },
        limit: Number(req.query.limit ?? 100),
      });
      return res.json({ events, count: events.length });
    }),
  );

  router.get(
    '/audit/verify',
    asyncRoute(async (req, res) => {
      const result = await verifyAuditChain();
      return res.status(result.valid ? 200 : 409).json(result);
    }),
  );

  /**
   * Revealing a patient's identity. A separate, logged act — the dashboard runs on
   * pseudonymous references, so this is where minimisation stops being a claim.
   */
  router.post(
    '/encounters/:id/reveal-identity',
    asyncRoute(async (req, res) => {
      const encounter = await repositories.encounters.findById(req.params.id);
      if (!encounter) return res.status(404).json({ error: 'encounter_not_found' });

      const clinician = await repositories.clinicians.findById(req.body?.clinicianId);
      if (!clinician) return res.status(404).json({ error: 'clinician_not_found' });
      if (clinician.canViewIdentity === false) {
        return res.status(403).json({ error: 'not_permitted_to_view_identity' });
      }

      const patient = await repositories.patients.findById(encounter.patientRef);
      const fields = Object.keys(patient.identity ?? {}).filter((key) => patient.identity[key]);

      const auditEvent = await recordPhiAccess({
        clinician,
        encounter,
        fields,
        purpose: req.body?.purpose ?? 'clinical_care',
        session: sessionFrom(req),
      });

      return res.json({ identity: patient.identity, auditSeq: auditEvent.seq });
    }),
  );

  // ------------------------------------------------------------------ model

  router.get(
    '/model/info',
    asyncRoute(async (req, res) => {
      const result = await fetchModelInfo();
      if (!result.ok) return res.status(503).json({ error: 'ml_unavailable', reason: result.reason });
      return res.json(result.data);
    }),
  );

  return router;
}
