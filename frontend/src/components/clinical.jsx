import './clinical.css';

/**
 * Shared clinical display primitives.
 *
 * The rule these all obey: a colour never carries meaning on its own. Every
 * badge shows its number, every status shows its state in words, every alert
 * carries a glyph. Roughly one man in twelve has some form of colour vision
 * deficiency, and a triage board that says "urgent" only in hue is unreadable to
 * them — which in this setting is a safety defect rather than an accessibility
 * shortfall.
 */

export const ESI_LABELS = {
  1: 'Resuscitation',
  2: 'Emergent',
  3: 'Urgent',
  4: 'Less urgent',
  5: 'Non-urgent',
};

/** ESI maps onto the reserved status roles, most urgent first. */
const ESI_STATUS = { 1: 'critical', 2: 'serious', 3: 'warning', 4: 'good', 5: 'neutral' };

export function EsiBadge({ esi, subBand, size = 'md' }) {
  if (!esi) return <span className="esi-badge esi-badge--unknown">Not yet scored</span>;
  return (
    <span
      className={`esi-badge esi-badge--${ESI_STATUS[esi]} esi-badge--${size}`}
      title={`ESI ${esi} — ${ESI_LABELS[esi]}`}
    >
      <strong className="tabular">
        {esi}
        {subBand ? subBand.slice(1) : ''}
      </strong>
      <span className="esi-badge__label">{ESI_LABELS[esi]}</span>
    </span>
  );
}

const DECAY_COPY = {
  green: { label: 'Within safe wait', glyph: '●' },
  amber: { label: 'Approaching limit', glyph: '◐' },
  red: { label: 'Safe wait exceeded', glyph: '▲' },
};

const DECAY_STATUS = { green: 'good', amber: 'warning', red: 'critical' };

export function DecayIndicator({ queue }) {
  const status = queue?.decayStatus ?? 'green';
  const copy = DECAY_COPY[status] ?? DECAY_COPY.green;
  const ratio = queue?.decayRatio ?? 0;
  const safeWait = queue?.safeWaitMinutes;

  // A ratio over 1 is the interesting number: how far past the safe wait, not how
  // far through it. Expressed as a percentage so it reads at a glance.
  const percent = Math.min(Math.round(ratio * 100), 999);

  return (
    <span className={`decay decay--${DECAY_STATUS[status]}`} title={`${copy.label} (${percent}% of safe wait)`}>
      <span aria-hidden="true" className="decay__glyph">
        {copy.glyph}
      </span>
      <span className="decay__text">
        <span className="decay__label">{copy.label}</span>
        <span className="decay__ratio tabular">
          {percent}%{safeWait != null && safeWait > 0 ? ` of ${safeWait}m` : ' — immediate'}
        </span>
      </span>
    </span>
  );
}

const CONFIDENCE_COPY = {
  high: { label: 'High confidence', status: 'good' },
  moderate: { label: 'Moderate confidence', status: 'warning' },
  low: { label: 'Low confidence', status: 'critical' },
};

/**
 * The brief requires that no score is ever shown without its uncertainty. This
 * component is the enforcement point on the client: given no confidence object it
 * says so loudly rather than rendering a bare, falsely-authoritative number.
 */
export function ConfidenceChip({ confidence, showBar = false }) {
  if (!confidence) {
    return <span className="confidence confidence--missing">Confidence not recorded</span>;
  }

  const copy = CONFIDENCE_COPY[confidence.band] ?? CONFIDENCE_COPY.moderate;
  const percent = Math.round((confidence.score ?? 0) * 100);

  return (
    <span className={`confidence confidence--${copy.status}`} title={confidence.drivers?.join('; ')}>
      <span className="confidence__label">{copy.label}</span>
      <span className="confidence__score tabular">{percent}%</span>
      {showBar && (
        <span className="confidence__bar" aria-hidden="true">
          <span className="confidence__bar-fill" style={{ width: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}

const FLAG_STATUS = { critical: 'critical', warning: 'warning', info: 'neutral' };

const SOURCE_COPY = {
  rule: 'Clinical rule',
  model: 'Risk model',
  confidence: 'Uncertainty',
  fusion: 'Safety layer',
};

/**
 * Explain flags, ordered by the backend so the most consequential reads first.
 *
 * The source label matters: a nurse weighs "fever under 3 months mandates a septic
 * screen" differently from "reported pain contributed +0.26 toward urgent". Both
 * belong on screen; only one of them is a clinical reason, and the interface
 * should not blur them together.
 */
export function ExplainFlags({ flags, limit }) {
  if (!flags?.length) return <p className="explain-empty">No flags raised.</p>;
  const shown = limit ? flags.slice(0, limit) : flags;

  return (
    <ul className="explain-list">
      {shown.map((flag, index) => (
        <li key={`${flag.code}-${index}`} className={`explain explain--${FLAG_STATUS[flag.severity] ?? 'neutral'}`}>
          <div className="explain__head">
            <span className="explain__label">{flag.label}</span>
            {flag.hardRedFlag && <span className="explain__pill explain__pill--hard">Model cannot downgrade</span>}
            {flag.ageBandSpecific && <span className="explain__pill">Age-specific</span>}
            <span className="explain__source">{SOURCE_COPY[flag.source] ?? flag.source}</span>
          </div>
          {flag.evidence && <div className="explain__evidence">{flag.evidence}</div>}
          {flag.rationale && <div className="explain__rationale">{flag.rationale}</div>}
        </li>
      ))}
      {limit && flags.length > limit && (
        <li className="explain explain--more">+{flags.length - limit} more</li>
      )}
    </ul>
  );
}

/**
 * Age, at the precision that matters clinically for that age.
 *
 * Rounding a six-week-old to "0y" is not a cosmetic problem here: the fever rule
 * that escalates any infant under three months turns on exactly this number, and
 * a nurse checking the assistant's reasoning needs to see the age the rule fired
 * on. Days for a neonate, weeks then months through infancy, years after that.
 */
export function formatAge(ageYears) {
  if (!Number.isFinite(ageYears)) return 'age unknown';
  const days = ageYears * 365.25;
  if (days < 28) return `${Math.max(0, Math.round(days))}d`;
  if (ageYears < 0.5) return `${Math.round(days / 7)} wks`;
  if (ageYears < 2) return `${Math.round(ageYears * 12)} mo`;
  return `${Math.round(ageYears)}y`;
}

/** Minutes → "1h 12m", so a long wait reads as a duration rather than 72. */
export function formatWait(minutes) {
  const total = Math.max(0, Math.round(minutes ?? 0));
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

export function minutesSince(iso) {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}
