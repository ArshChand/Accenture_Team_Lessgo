import { useRef, useState } from 'react';
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

export function IntakeKiosk({ onArrival }) {
  const [language, setLanguage] = useState('kn-IN');
  const [transcript, setTranscript] = useState('');
  const [asrConfidence, setAsrConfidence] = useState(0.9);
  const [listening, setListening] = useState(false);
  const [age, setAge] = useState('58');
  const [complaint, setComplaint] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);

  const startListening = () => {
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.lang = language;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const best = event.results[0][0];
      setTranscript(best.transcript);
      // The browser's own confidence, carried through rather than assumed perfect.
      setAsrConfidence(Number.isFinite(best.confidence) && best.confidence > 0 ? best.confidence : 0.75);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
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
        hasPriorRecord: false,
      });

      const { encounter } = await api.createEncounter({
        patientRef: patient._id,
        ageYears: Number(age),
        chiefComplaint: complaint || transcript.slice(0, 60) || 'unspecified',
        mode: 'walk_in',
        transcripts: transcript
          ? [{ language, rawText: transcript, asrConfidence, captureMode: SpeechRecognition ? 'web_speech' : 'scripted' }]
          : [],
      });

      setResult(encounter);
      onArrival?.(String(encounter._id));
      setTranscript('');
      setComplaint('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kiosk">
      <header className="kiosk__head">
        <h2>Patient intake</h2>
        <p>Speak your symptoms in your own language. A nurse will review everything.</p>
      </header>

      <form onSubmit={submit} className="kiosk__form">
        <div className="kiosk__langs" role="group" aria-label="Language">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              className={`kiosk__lang ${language === lang.code ? 'is-active' : ''}`}
              onClick={() => setLanguage(lang.code)}
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
        </div>

        <div className="kiosk__scripts">
          <span className="kiosk__scripts-label">Example utterances</span>
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
          <span className="field__hint">
            Speech recognition confidence {Math.round(asrConfidence * 100)}% — a low figure makes the
            assistant more cautious, not less.
          </span>
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
