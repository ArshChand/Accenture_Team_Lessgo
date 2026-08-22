"""Extraction tests, written as claims about what the system understands.

Negation gets the most attention here because getting it wrong is silent and
inverts clinical meaning: turning "chest pain but no fever" into a denial of chest
pain removes the most urgent symptom in the sentence and nothing downstream can
tell that it happened.
"""

import pytest

from app.nlp import LANGUAGE_COVERAGE, extract


def sx(text, lang="en-IN", asr=0.9):
    result = extract(text, lang, asr)
    return sorted(result.symptoms), sorted(result.negations)


class TestAffirmation:
    def test_english_symptoms(self):
        symptoms, _ = sx("I have chest pain radiating to my left arm and I am sweating")
        assert "chest_pain" in symptoms
        assert "radiating_pain" in symptoms
        assert "sweating" in symptoms

    def test_filler_words_do_not_break_a_phrase(self):
        # "face drooping" in the lexicon, "face is drooping" in the utterance.
        symptoms, _ = sx("my face is drooping and I cannot speak properly")
        assert symptoms == ["facial_droop", "speech_difficulty"]

    def test_hindi_symptoms(self):
        symptoms, _ = sx("bukhar hai aur ulti ho rahi hai", "hi-IN")
        assert symptoms == ["fever", "vomiting"]

    def test_kannada_symptoms(self):
        symptoms, _ = sx("nanage hotte novu tumba ide", "kn-IN")
        assert "abdominal_pain" in symptoms

    def test_devanagari_script(self):
        symptoms, _ = sx("सीने में दर्द और बुखार", "hi-IN")
        assert "chest_pain" in symptoms
        assert "fever" in symptoms

    def test_kannada_script(self):
        symptoms, _ = sx("ಎದೆ ನೋವು ಮತ್ತು ಜ್ವರ", "kn-IN")
        assert "chest_pain" in symptoms
        assert "fever" in symptoms

    def test_code_switching_falls_back_to_english(self):
        # Speaking Kannada but naming the symptom in English is the norm, not an edge case.
        symptoms, _ = sx("nanage chest pain ide", "kn-IN")
        assert symptoms == ["chest_pain"]


class TestNegation:
    def test_english_pre_negation(self):
        symptoms, negations = sx("abdominal pain but no fever and no vomiting")
        assert symptoms == ["abdominal_pain"]
        assert negations == ["fever", "vomiting"]

    def test_hindi_post_negation(self):
        # Hindi negates after the noun: "bukhar nahi" is "no fever".
        symptoms, negations = sx("seene mein dard hai lekin bukhar nahi hai", "hi-IN")
        assert symptoms == ["chest_pain"]
        assert negations == ["fever"]

    def test_kannada_post_negation(self):
        symptoms, negations = sx("hotte novu ide aadare jvara illa", "kn-IN")
        assert symptoms == ["abdominal_pain"]
        assert negations == ["fever"]

    @pytest.mark.parametrize(
        "text,language",
        [
            ("chest pain but no fever", "en-IN"),
            ("seene mein dard hai lekin bukhar nahi hai", "hi-IN"),
            ("hotte novu ide aadare jvara illa", "kn-IN"),
        ],
    )
    def test_negation_never_reaches_across_a_clause_boundary(self, text, language):
        """The single most dangerous parsing error this extractor could make."""
        symptoms, negations = sx(text, language)
        assert symptoms, f"the affirmed symptom was swallowed by a negation in: {text}"
        assert not (set(symptoms) & set(negations))

    def test_punctuation_ends_a_clause(self):
        symptoms, _ = sx("no chest, abdominal pain only")
        # The extractor does not invent a "chest pain" mention out of "no chest,".
        # What matters is that the abdominal pain survives unnegated.
        assert "abdominal_pain" in symptoms

    def test_contradiction_resolves_toward_the_symptom(self):
        _, negations = sx("no chest pain, actually chest pain now")
        assert "chest_pain" not in negations


class TestConfidence:
    def test_poor_audio_lowers_derived_reliability(self):
        clear = extract("I have chest pain", "en-IN", 0.95)
        muffled = extract("I have chest pain", "en-IN", 0.40)
        # Extraction confidence is about understanding, not hearing, so it is
        # unchanged; the ASR term is applied separately by the caller.
        assert clear.extraction_confidence == muffled.extraction_confidence

    def test_thinner_language_coverage_lowers_confidence(self):
        english = extract("I have chest pain", "en-IN", 0.9)
        kannada = extract("ede novu ide", "kn-IN", 0.9)
        assert kannada.extraction_confidence < english.extraction_confidence
        assert LANGUAGE_COVERAGE["kn"] < LANGUAGE_COVERAGE["en"]

    def test_unrecognised_speech_lowers_confidence(self):
        recognised = extract("chest pain", "en-IN", 0.9)
        mostly_noise = extract(
            "chest pain and lots of other unfamiliar clinical terminology nobody mapped", "en-IN", 0.9
        )
        assert mostly_noise.extraction_confidence < recognised.extraction_confidence

    def test_nothing_understood_is_low_confidence_not_zero_symptoms_silently(self):
        result = extract("qwerty asdf zxcv", "en-IN", 0.9)
        assert result.symptoms == []
        assert result.extraction_confidence < 0.5
        # Unmapped words are surfaced, never discarded: a word we failed to
        # understand is a reason to look, not a reason to assume nothing was said.
        assert result.unmapped_terms


class TestStructuredDetail:
    @pytest.mark.parametrize(
        "text,expected_hours",
        [("since 2 hours", 2.0), ("2 din se", 48.0), ("3 days ago", 72.0), ("30 minutes", 0.5)],
    )
    def test_onset_parsing(self, text, expected_hours):
        assert extract(f"chest pain {text}", "en-IN").onset_hours == expected_hours

    def test_severity_words_are_captured(self):
        assert "severe" in extract("severe chest pain", "en-IN").severity_words
        assert "tumba" in extract("hotte novu tumba ide", "kn-IN").severity_words

    def test_every_match_is_traceable_to_its_phrase(self):
        result = extract("seene mein dard hai", "hi-IN")
        assert result.matched_terms
        for match in result.matched_terms:
            assert match["symptom"]
            assert match["matchedPhrase"]
            assert match["phraseLanguage"] in {"en", "hi", "kn"}

    def test_gloss_is_labelled_as_a_gloss_not_a_translation(self):
        result = extract("hotte novu", "kn-IN")
        assert "abdominal pain" in result.gloss
