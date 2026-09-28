import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import './IntakeKiosk.css';

/**
 * Patient-facing intake.
 *
 * Live dictation uses the browser's Web Speech API where it exists, with a
 * scripted-transcript fallback everywhere else. Both paths feed the same
 * extraction endpoint, and both carry an ASR confidence figure — which is not
 * cosmetic: it propagates into the reliability of every symptom derived from the
 * utterance, and from there into the assistant's confidence and, if low enough,
 * into an escalation. A patient the system heard poorly is scored more cautiously.
 */

const LANGUAGES = [
  { code: 'kn-IN', label: 'ಕನ್ನಡ', english: 'Kannada' },
  { code: 'hi-IN', label: 'हिन्दी', english: 'Hindi' },
  { code: 'en-IN', label: 'English', english: 'English' },
];

/** Scripted utterances for demo and for browsers with no speech recognition. */
const SCRIPTS = {
  'kn-IN': [
    { text: 'nanage ede novu tumba ide, bevaru barutta ide', gloss: 'severe chest pain, sweating', asr: 0.71 },
    { text: 'hotte novu ide aadare jvara illa', gloss: 'stomach pain but no fever', asr: 0.48 },
    { text: 'nanage sustu tumba ide, usiru kattuttide', gloss: 'very weak, breathless', asr: 0.62 },
  ],
  'hi-IN': [
    { text: 'seene mein dard hai aur pasina aa raha hai', gloss: 'chest pain and sweating', asr: 0.83 },
    { text: 'bukhar hai aur ulti ho rahi hai', gloss: 'fever and vomiting', asr: 0.88 },
    { text: 'saans lene mein takleef ho rahi hai', gloss: 'difficulty breathing', asr: 0.79 },
  ],
  'en-IN': [
    { text: 'I have chest pain radiating to my left arm and I am sweating', gloss: '', asr: 0.95 },
    { text: 'my face is drooping and I cannot speak properly since 2 hours', gloss: '', asr: 0.93 },
    { text: 'my child has a fever and is not feeding', gloss: '', asr: 0.9 },
  ],
};

const SpeechRecognition =
  typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

// Every browser on an iPhone or iPad is WebKit underneath, and WebKit hands
// speech to Apple's dictation service, which must be switched on in Settings.
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

const LANGUAGE_NAMES = Object.fromEntries(LANGUAGES.map((lang) => [lang.code, lang.english]));

/** A plain-language reason for a recognition error, or null when there is nothing to say. */
function speechErrorMessage(code, language) {
  switch (code) {
    case 'aborted':
      return null;
    case 'language-not-supported':
      return `This device's speech service doesn't support ${LANGUAGE_NAMES[language] ?? 'this language'}. Tap an example below, or type what the patient says.`;
    case 'not-allowed':
    case 'service-not-allowed':
      return IS_IOS
        ? 'Speech recognition is switched off. On iPhone, turn on Settings → General → Keyboard → Enable Dictation, then allow the microphone for this site.'
        : "Microphone access was blocked. Allow it in the browser's site settings, then tap again.";
    case 'audio-capture':
      return 'No microphone was found on this device.';
    case 'network':
      return "The speech service couldn't be reached. Check the connection, or type instead.";
    case 'no-speech':
    default:
      return "Didn't catch that. Tap and speak again, or type instead.";
  }
}

export function IntakeKiosk({ onArrival, mode = 'staff' }) {
  const isPatient = mode === 'patient';
  const [language, setLanguage] = useState('kn-IN');
  const [transcript, setTranscript] = useState('');
  const [asrConfidence, setAsrConfidence] = useState(0.9);
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState(null);
  const [age, setAge] = useState('58');
  const [complaint, setComplaint] = useState('');
  const [phone, setPhone] = useState('');
  const [hisMatch, setHisMatch] = useState(null);
  const [hisLookupState, setHisLookupState] = useState('idle'); // idle | checking | found | not_found | error
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [viaProxy, setViaProxy] = useState(false);
  const recognitionRef = useRef(null);

  /**
   * Half of arrivals have some prior record, per the brief's own assumption —
   * but "prior record" usually means the *hospital's* record, not this app's.
   * A patient can be a complete stranger to TriageHandler and a known quantity
   * to the hospital's own HIS. This looks the hospital's system up directly
   * rather than only checking our own database, and is read-only: it informs
   * intake with baselines and chronic conditions, it never writes anything
   * back and never touches a score by itself.
   */
  const checkHospitalRecord = async () => {
    if (!phone.trim()) return;
    setHisLookupState('checking');
    setHisMatch(null);
    try {
      const { found, record } = await api.hisLookup({ phone: phone.trim() });
      setHisMatch(found ? record : null);
      setHisLookupState(found ? 'found' : 'not_found');
    } catch {
      setHisLookupState('error');
    }
  };

  // A recognition still running when the kiosk goes away would keep the mic open.
  useEffect(() => () => recognitionRef.current?.abort(), []);

  const startListening = () => {
    if (!SpeechRecognition) return;
    recognitionRef.current?.abort();
    setSpeechError(null);

    const recognition = new SpeechRecognition();
    recognition.lang = language;
    // Interim results on, because iOS often ends a session without ever marking
    // a result final; the words heard so far are kept rather than thrown away.
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let heard = '';
    let failed = false;

    recognition.onresult = (event) => {
      const results = Array.from(event.results);
      heard = results.map((result) => result[0].transcript).join(' ').replace(/\s+/g, ' ').trim();
      setTranscript(heard);
      // The browser's own confidence, carried through rather than assumed perfect.
      const scores = results
        .filter((result) => result.isFinal && result[0].confidence > 0)
        .map((result) => result[0].confidence);
      setAsrConfidence(scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.75);
    };
    recognition.onerror = (event) => {
      failed = true;
      setSpeechError(speechErrorMessage(event.error, language));
      setListening(false);
    };
    recognition.onend = () => {
      if (!heard && !failed) setSpeechError(speechErrorMessage('no-speech', language));
      setListening(false);
    };

    recognitionRef.current = recognition;
    setListening(true);
    // start() has to run inside the tap itself; Safari refuses it otherwise.
    try {
      recognition.start();
    } catch {
      setSpeechError("Couldn't start the microphone. Tap again, or type instead.");
      setListening(false);
    }
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  const useScript = (script) => {
    setTranscript(script.text);
    setAsrConfidence(script.asr);
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const ref = `P-${Math.floor(1000 + Math.random() * 8999)}`;
      const { patient } = await api.createPatient({
        displayRef: ref,
        preferredLanguage: language,
        hasPriorRecord: Boolean(hisMatch),
        ...(hisMatch && {
          identity: { phone: phone.trim(), fullName: hisMatch.fullName },
          baselines: {
            systolicBP: hisMatch.baselineSBP,
            heartRate: hisMatch.baselineHR,
            spo2: hisMatch.baselineSpO2,
          },
          chronicConditions: hisMatch.chronicConditions,
          allergies: hisMatch.allergies,
          medications: hisMatch.medications,
        }),
      });

      const { encounter } = await api.createEncounter({
        patientRef: patient._id,
        ageYears: Number(age),
        chiefComplaint: complaint || transcript.slice(0, 60) || 'unspecified',
        mode: 'walk_in',
        viaProxy,
        transcripts: transcript
          ? [{ language, rawText: transcript, asrConfidence, captureMode: SpeechRecognition ? 'web_speech' : 'scripted' }]
          : [],
      });

      if (!isPatient) setResult(encounter);
      onArrival?.(String(encounter._id), encounter);
      setViaProxy(false);
      setTranscript('');
      setComplaint('');
      setPhone('');
      setHisMatch(null);
      setHisLookupState('idle');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kiosk">
      <header className="kiosk__head">
        <h2>{isPatient ? 'Tell us what is wrong' : 'Patient intake'}</h2>
        <p>
          {isPatient
            ? 'Speak in your own language. No sign-in needed — a nurse reviews everything you say.'
            : 'Speak your symptoms in your own language. A nurse will review everything.'}
        </p>
      </header>

      <form onSubmit={submit} className="kiosk__form">
        <div className="kiosk__langs" role="group" aria-label="Language">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              className={`kiosk__lang ${language === lang.code ? 'is-active' : ''}`}
              onClick={() => {
                setLanguage(lang.code);
                setSpeechError(null);
              }}
            >
              <strong>{lang.label}</strong>
              <span>{lang.english}</span>
            </button>
          ))}
        </div>

        <div className="kiosk__mic">
          {SpeechRecognition ? (
            <button
              type="button"
              className={`kiosk__mic-btn ${listening ? 'is-listening' : ''}`}
              onClick={listening ? stopListening : startListening}
            >
              {listening ? 'Listening… tap to stop' : 'Tap and speak'}
            </button>
          ) : (
            <p className="kiosk__nospeech">
              This browser has no speech recognition. Use a scripted example below, or type.
            </p>
          )}
          {speechError && (
            <p className="kiosk__speech-error" role="status">
              {speechError}
            </p>
          )}
        </div>

        <div className="kiosk__scripts">
          <span className="kiosk__scripts-label">{isPatient ? 'Or tap an example' : 'Example utterances'}</span>
          {(SCRIPTS[language] ?? []).map((script) => (
            <button key={script.text} type="button" className="kiosk__script" onClick={() => useScript(script)}>
              <span className="kiosk__script-text">{script.text}</span>
              {script.gloss && <span className="kiosk__script-gloss">{script.gloss}</span>}
              <span className="kiosk__script-asr tabular">recognition {Math.round(script.asr * 100)}%</span>
            </button>
          ))}
        </div>

        <label className="field">
          <span className="field__label">Transcript</span>
          <textarea rows={3} value={transcript} onChange={(e) => setTranscript(e.target.value)} />
          {!isPatient && (
            <span className="field__hint">
              Speech recognition confidence {Math.round(asrConfidence * 100)}% — a low figure makes the
              assistant more cautious, not less.
            </span>
          )}
        </label>

        <div className="kiosk__grid">
          <label className="field">
            <span className="field__label">Age (years)</span>
            <input type="number" value={age} onChange={(e) => setAge(e.target.value)} min="0" max="120" />
          </label>
          <label className="field">
            <span className="field__label">Chief complaint</span>
            <input
              type="text"
              value={complaint}
              onChange={(e) => setComplaint(e.target.value)}
              placeholder="optional — taken from speech if blank"
            />
          </label>
        </div>

        <label className="field">
          <span className="field__label">Phone number (optional)</span>
          <div className="kiosk__phone-row">
            <input
              type="tel"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setHisMatch(null);
                setHisLookupState('idle');
              }}
              placeholder="for checking the hospital's own record"
            />
            <button
              type="button"
              className="btn"
              onClick={checkHospitalRecord}
              disabled={!phone.trim() || hisLookupState === 'checking'}
            >
              {hisLookupState === 'checking' ? 'Checking…' : 'Check hospital record'}
            </button>
          </div>
          <span className="field__hint">
            {isPatient
              ? 'If you have been to this hospital before, we can use your existing record.'
              : "Looks up the hospital's own patient record system — separate from this app's database, and read-only. A match pre-fills baselines and chronic conditions the assistant can use; nothing is written back."}
          </span>
        </label>

        <label className="kiosk__proxy">
          <input type="checkbox" checked={viaProxy} onChange={(e) => setViaProxy(e.target.checked)} />
          <span>I am filling this in for someone else (family member or attendant)</span>
        </label>

        {hisLookupState === 'found' && hisMatch && (
          <div className="kiosk__his kiosk__his--found">
            <strong>{hisMatch.fullName}</strong>, {hisMatch.ageYears}y — known to the hospital's system
            <ul>
              {hisMatch.chronicConditions?.length > 0 && <li>Chronic: {hisMatch.chronicConditions.join(', ')}</li>}
              {hisMatch.allergies?.length > 0 && <li>Allergies: {hisMatch.allergies.join(', ')}</li>}
              <li>
                Baseline: SBP {hisMatch.baselineSBP} · HR {hisMatch.baselineHR} · SpO2 {hisMatch.baselineSpO2}%
              </li>
              <li>Last visit {hisMatch.lastVisit}</li>
            </ul>
            <span className="kiosk__his-source">{hisMatch.source}</span>
          </div>
        )}
        {hisLookupState === 'not_found' && (
          <p className="kiosk__his kiosk__his--miss">
            No record for this number in the hospital's system. Registering as a first-time patient.
          </p>
        )}
        {hisLookupState === 'error' && (
          <p className="kiosk__his kiosk__his--miss">
            The hospital's record system did not respond. Continuing without it — this never blocks intake.
          </p>
        )}

        <button type="submit" className="btn btn--primary" disabled={busy || (!transcript && !complaint)}>
          {busy ? 'Registering…' : 'Join the queue'}
        </button>

        {error && <p className="kiosk__error">{error}</p>}

        {result && (
          <div className="kiosk__result">
            <strong>{result.displayRef}</strong> registered.
            {result.intake?.extraction?.symptoms?.length > 0 && (
              <div>
                Understood: {result.intake.extraction.symptoms.map((s) => s.replace(/_/g, ' ')).join(', ')}
                {result.intake.extraction.negations?.length > 0 && (
                  <> · ruled out: {result.intake.extraction.negations.map((s) => s.replace(/_/g, ' ')).join(', ')}</>
                )}
              </div>
            )}
            <div className="kiosk__result-hint">
              Record observations from the dashboard to have the assistant score this patient.
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
