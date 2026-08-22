import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { RISK_CONDITIONS, SYMPTOMS } from '../src/clinical/symptoms.js';
import { AGE_BANDS } from '../src/clinical/constants.js';

/**
 * The controlled vocabulary is defined twice — once in JavaScript for the rule
 * engine and once in Python for the feature builder — because the two services
 * are separate processes in separate languages.
 *
 * Duplication like that drifts silently, and the failure mode is nasty: the NLP
 * layer extracts `chest_pain`, the model one-hot encodes a feature nobody sets,
 * and the rule that looks for chest pain never fires. Nothing errors. The patient
 * is simply scored as though they never mentioned it.
 *
 * These tests read the Python source directly and fail the build the moment the
 * two lists disagree.
 */

const mlAppDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ml-service', 'app');

/** Pull a top-level `NAME: list[str] = [...]` literal out of the Python source. */
function pythonStringList(source, name) {
  const match = source.match(new RegExp(`${name}\\s*:\\s*list\\[str\\]\\s*=\\s*\\[([\\s\\S]*?)\\n\\]`));
  assert.ok(match, `could not find ${name} in the Python source`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const featuresSource = readFileSync(join(mlAppDir, 'features.py'), 'utf8');
const nlpSource = readFileSync(join(mlAppDir, 'nlp.py'), 'utf8');

describe('symptom vocabulary parity between the rule engine and the model', () => {
  it('defines exactly the same symptom codes on both sides', () => {
    const python = pythonStringList(featuresSource, 'SYMPTOMS');

    const onlyInJs = SYMPTOMS.filter((s) => !python.includes(s));
    const onlyInPython = python.filter((s) => !SYMPTOMS.includes(s));

    assert.deepEqual(onlyInJs, [], 'symptoms defined in JavaScript but not in the feature builder');
    assert.deepEqual(onlyInPython, [], 'symptoms defined in the feature builder but not in JavaScript');
  });

  it('defines exactly the same chronic conditions on both sides', () => {
    const python = pythonStringList(featuresSource, 'CONDITIONS');

    assert.deepEqual(
      RISK_CONDITIONS.filter((c) => !python.includes(c)),
      [],
      'conditions in JavaScript but not in the feature builder',
    );
    assert.deepEqual(
      python.filter((c) => !RISK_CONDITIONS.includes(c)),
      [],
      'conditions in the feature builder but not in JavaScript',
    );
  });

  it('defines the same age bands in the same order', () => {
    assert.deepEqual(pythonStringList(featuresSource, 'AGE_BANDS'), AGE_BANDS);
  });
});

describe('the NLP lexicon only produces symptoms the rule engine understands', () => {
  it('maps every lexicon entry onto a known symptom code', () => {
    // Keys of the LEXICON dict, e.g. `    "chest_pain": {`.
    const lexiconBlock = nlpSource.match(/LEXICON:[\s\S]*?\n\}/);
    assert.ok(lexiconBlock, 'could not find LEXICON in nlp.py');

    const codes = [...lexiconBlock[0].matchAll(/^\s{4}"([a-z_]+)":\s*\{/gm)].map((m) => m[1]);
    assert.ok(codes.length > 30, `expected a substantial lexicon, found ${codes.length} entries`);

    const unknown = codes.filter((code) => !SYMPTOMS.includes(code));
    assert.deepEqual(
      unknown,
      [],
      'the extractor can emit these codes but the rule engine has never heard of them',
    );
  });

  it('covers the symptoms the safety-critical rules depend on', () => {
    const lexiconBlock = nlpSource.match(/LEXICON:[\s\S]*?\n\}/)[0];
    const codes = [...lexiconBlock.matchAll(/^\s{4}"([a-z_]+)":\s*\{/gm)].map((m) => m[1]);

    // If a patient can say it and a hard red flag depends on it, the extractor
    // must be able to hear it in every supported language.
    const safetyCritical = [
      'chest_pain',
      'facial_droop',
      'unilateral_weakness',
      'speech_difficulty',
      'dyspnoea',
      'confusion',
      'fever',
      'head_injury',
      'fall',
      'overdose',
      'self_harm',
      'poor_feeding',
      'seizure',
    ];

    const missing = safetyCritical.filter((code) => !codes.includes(code));
    assert.deepEqual(missing, [], 'safety-critical symptoms with no way to be spoken');
  });

  it('gives every lexicon entry all three supported languages', () => {
    const lexiconBlock = nlpSource.match(/LEXICON:[\s\S]*?\n\}/)[0];
    const entries = [...lexiconBlock.matchAll(/^\s{4}"([a-z_]+)":\s*\{([\s\S]*?)^\s{4}\},/gm)];
    assert.ok(entries.length > 30);

    for (const [, code, body] of entries) {
      for (const language of ['en', 'hi', 'kn']) {
        assert.ok(
          new RegExp(`"${language}":\\s*\\[`).test(body),
          `lexicon entry "${code}" has no ${language} phrases — a patient speaking that language cannot report it`,
        );
      }
    }
  });
});
