"""Multilingual symptom extraction for Kannada, Hindi and English intake.

This is a lexicon-and-pattern extractor, not a neural model, and that is a
deliberate choice for a triage prototype rather than a shortcut. Three reasons:

* It is inspectable. Every extracted symptom can be traced to the exact phrase
  that produced it, which is what lets the dashboard show the nurse the patient's
  own words next to the machine's reading of them.
* It degrades honestly. Coverage for Kannada and Hindi is genuinely thinner than
  for English, and the extractor reports that as lower confidence rather than
  guessing with the same swagger in every language. A patient who is understood
  less well should be escalated more readily, not scored as if nothing was lost.
* It runs offline. No network call sits between a patient speaking and a score.

What it does *not* do is translate. It produces an English gloss built from the
matched terms, labelled as a gloss, because a mistranslation presented as a
translation is worse than no translation at all.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

# Symptom code -> phrases that indicate it, per language.
# Entries include both native script and the romanised forms people actually type.
LEXICON: dict[str, dict[str, list[str]]] = {
    "chest_pain": {
        "en": ["chest pain", "chest tightness", "pain in chest", "chest pressure", "tight chest", "heaviness in chest"],
        "hi": ["सीने में दर्द", "छाती में दर्द", "seene mein dard", "chhati mein dard", "chati dard"],
        "kn": ["ಎದೆ ನೋವು", "ಎದೆನೋವು", "ede novu", "edenovu", "ede novu"],
    },
    "radiating_pain": {
        "en": ["radiating", "spreading to arm", "pain in left arm", "pain going to jaw", "shooting down"],
        "hi": ["बाएं हाथ में दर्द", "baaye haath mein dard", "haath tak dard"],
        "kn": ["ಕೈಗೆ ನೋವು", "kai ge novu", "kaige novu"],
    },
    "dyspnoea": {
        "en": ["breathless", "short of breath", "shortness of breath", "cannot breathe", "difficulty breathing", "gasping", "hard to breathe"],
        "hi": ["साँस लेने में तकलीफ", "सांस फूलना", "saans lene mein takleef", "saans phoolna", "saans nahi aa rahi", "dam ghutna"],
        "kn": ["ಉಸಿರಾಟದ ತೊಂದರೆ", "ಉಸಿರು ಕಟ್ಟುತ್ತಿದೆ", "usiratada tondare", "usiru kattuttide", "usiru tondare"],
    },
    "abdominal_pain": {
        "en": ["stomach pain", "abdominal pain", "belly pain", "tummy pain", "stomach ache", "pain in abdomen"],
        "hi": ["पेट दर्द", "पेट में दर्द", "pet dard", "pet mein dard"],
        "kn": ["ಹೊಟ್ಟೆ ನೋವು", "ಹೊಟ್ಟೆನೋವು", "hotte novu", "hottenovu", "hotte novu"],
    },
    "headache": {
        "en": ["headache", "head pain", "head ache", "pain in head"],
        "hi": ["सिर दर्द", "सर दर्द", "sir dard", "sar dard"],
        "kn": ["ತಲೆ ನೋವು", "ತಲೆನೋವು", "tale novu", "talenovu"],
    },
    "fever": {
        "en": ["fever", "temperature", "feverish", "hot to touch", "chills"],
        "hi": ["बुखार", "ज्वर", "bukhar", "bukhaar", "taap"],
        "kn": ["ಜ್ವರ", "jvara", "jwara", "javara"],
    },
    "vomiting": {
        "en": ["vomiting", "throwing up", "vomited", "being sick"],
        "hi": ["उल्टी", "ulti", "ultee"],
        "kn": ["ವಾಂತಿ", "vanti", "vaanti"],
    },
    "nausea": {
        "en": ["nausea", "nauseous", "feel sick", "queasy"],
        "hi": ["जी मिचलाना", "matli", "ji michalna"],
        "kn": ["ವಾಕರಿಕೆ", "vakarike"],
    },
    "diarrhoea": {
        "en": ["diarrhoea", "diarrhea", "loose motion", "loose stools"],
        "hi": ["दस्त", "पतले दस्त", "dast", "loose motion"],
        "kn": ["ಭೇದಿ", "bhedi"],
    },
    "dizziness": {
        "en": ["dizzy", "dizziness", "lightheaded", "giddy", "spinning"],
        "hi": ["चक्कर", "chakkar", "chakkar aana"],
        "kn": ["ತಲೆಸುತ್ತು", "talesuttu", "tale suttu"],
    },
    "syncope": {
        "en": ["fainted", "passed out", "blacked out", "collapsed", "lost consciousness"],
        "hi": ["बेहोश", "behosh", "behoshi"],
        "kn": ["ಪ್ರಜ್ಞೆ ತಪ್ಪಿತು", "pragne tappitu", "moorche"],
    },
    "cough": {
        "en": ["cough", "coughing"],
        "hi": ["खांसी", "खाँसी", "khansi", "khaansi"],
        "kn": ["ಕೆಮ್ಮು", "kemmu"],
    },
    "sore_throat": {
        "en": ["sore throat", "throat pain", "painful swallowing"],
        "hi": ["गले में दर्द", "gale mein dard", "gala kharab"],
        "kn": ["ಗಂಟಲು ನೋವು", "gantalu novu"],
    },
    "fatigue": {
        "en": ["tired", "fatigue", "exhausted", "no energy", "weak"],
        "hi": ["कमजोरी", "थकान", "kamzori", "thakan"],
        "kn": ["ಸುಸ್ತು", "ಆಯಾಸ", "sustu", "ayasa"],
    },
    "malaise": {
        "en": ["not myself", "not feeling right", "unwell", "off colour", "something is wrong"],
        "hi": ["तबीयत ठीक नहीं", "tabiyat theek nahi", "achha nahi lag raha"],
        "kn": ["ಸರಿ ಇಲ್ಲ", "sari illa", "hushar illa"],
    },
    "confusion": {
        "en": ["confused", "disoriented", "not making sense", "muddled", "forgetful today"],
        "hi": ["उलझन", "bhram", "uljhan", "yaad nahi"],
        "kn": ["ಗೊಂದಲ", "gondala"],
    },
    "palpitations": {
        "en": ["palpitations", "heart racing", "fluttering", "pounding heart"],
        "hi": ["धड़कन तेज", "dhadkan tez"],
        "kn": ["ಎದೆ ಬಡಿತ", "ede badita"],
    },
    "back_pain": {
        "en": ["back pain", "backache", "lower back pain"],
        "hi": ["कमर दर्द", "पीठ दर्द", "kamar dard", "peeth dard"],
        "kn": ["ಬೆನ್ನು ನೋವು", "bennu novu"],
    },
    "joint_pain": {
        "en": ["joint pain", "knee pain", "shoulder pain", "ankle pain"],
        "hi": ["जोड़ों में दर्द", "jodo mein dard", "ghutne mein dard"],
        "kn": ["ಕೀಲು ನೋವು", "keelu novu"],
    },
    "fall": {
        "en": ["fell", "fall", "had a fall", "slipped", "tripped"],
        "hi": ["गिर गया", "गिर गई", "gir gaya", "gir gayi"],
        "kn": ["ಬಿದ್ದೆ", "bidde", "bittu bidde"],
    },
    "head_injury": {
        "en": ["hit my head", "head injury", "banged head", "struck head"],
        "hi": ["सिर पर चोट", "sir par chot"],
        "kn": ["ತಲೆಗೆ ಪೆಟ್ಟು", "talege pettu"],
    },
    "bleeding": {
        "en": ["bleeding", "blood loss", "losing blood"],
        "hi": ["खून बह रहा", "khoon beh raha", "khoon"],
        "kn": ["ರಕ್ತಸ್ರಾವ", "raktasrava", "rakta"],
    },
    "laceration": {
        "en": ["cut", "gash", "laceration", "deep cut"],
        "hi": ["कट गया", "kat gaya", "ghaav"],
        "kn": ["ಗಾಯ", "gaya", "kattu"],
    },
    "deformity": {
        "en": ["deformed", "bent", "looks broken", "out of shape"],
        "hi": ["टेढ़ा", "tedha", "toot gaya"],
        "kn": ["ಮುರಿದಿದೆ", "muridide"],
    },
    "rash": {
        "en": ["rash", "spots", "skin eruption", "hives"],
        "hi": ["चकत्ते", "दाने", "chakatte", "daane"],
        "kn": ["ಗುಳ್ಳೆ", "gulle", "chukke"],
    },
    "seizure": {
        "en": ["seizure", "fit", "convulsion", "shaking uncontrollably"],
        "hi": ["दौरा", "मिर्गी", "daura", "mirgi"],
        "kn": ["ಮೂರ್ಛೆ", "moorche rogam", "fits"],
    },
    "facial_droop": {
        "en": ["face drooping", "face is crooked", "mouth pulled to one side"],
        "hi": ["चेहरा टेढ़ा", "chehra tedha"],
        "kn": ["ಮುಖ ವಕ್ರ", "mukha vakra"],
    },
    "unilateral_weakness": {
        "en": ["one side weak", "cannot move my arm", "left side weakness", "right side weakness", "arm is heavy"],
        "hi": ["एक तरफ कमजोरी", "ek taraf kamzori", "haath nahi uth raha"],
        "kn": ["ಒಂದು ಕಡೆ ಶಕ್ತಿ ಇಲ್ಲ", "ondu kade shakti illa"],
    },
    "speech_difficulty": {
        "en": ["slurred speech", "cannot speak properly", "words not coming", "speech difficulty"],
        "hi": ["बोलने में दिक्कत", "bolne mein dikkat", "zubaan latpat"],
        "kn": ["ಮಾತು ತೊದಲುತ್ತಿದೆ", "maatu todalutide"],
    },
    "visual_disturbance": {
        "en": ["blurred vision", "cannot see properly", "double vision", "vision loss"],
        "hi": ["धुंधला दिखना", "dhundhla dikhna", "aankh se nahi dikh raha"],
        "kn": ["ಮಂಜು ಕಾಣುತ್ತಿದೆ", "manju kanutide"],
    },
    "dysuria": {
        "en": ["burning urine", "painful urination", "burning when passing urine"],
        "hi": ["पेशाब में जलन", "peshab mein jalan"],
        "kn": ["ಮೂತ್ರದಲ್ಲಿ ಉರಿ", "mutradalli uri"],
    },
    "poor_feeding": {
        "en": ["not feeding", "refusing feeds", "not drinking milk", "off feeds"],
        "hi": ["दूध नहीं पी रहा", "doodh nahi pi raha"],
        "kn": ["ಹಾಲು ಕುಡಿಯುತ್ತಿಲ್ಲ", "haalu kudiyuttilla"],
    },
    "lethargy": {
        "en": ["very sleepy", "lethargic", "will not wake", "drowsy", "floppy"],
        "hi": ["सुस्त", "sust", "neend mein"],
        "kn": ["ಜಡ", "jada", "nidre"],
    },
    "irritability": {
        "en": ["irritable", "crying constantly", "inconsolable", "will not settle"],
        "hi": ["चिड़चिड़ा", "chidchida", "ro raha hai"],
        "kn": ["ಅಳುತ್ತಿದೆ", "aluttide"],
    },
    "indigestion": {
        "en": ["indigestion", "gas", "acidity", "heartburn", "burning in stomach"],
        "hi": ["गैस", "अपच", "gas", "apach", "jalan"],
        "kn": ["ಅಜೀರ್ಣ", "ajeerna", "gas"],
    },
    "sweating": {
        "en": ["sweating", "cold sweat", "clammy", "drenched in sweat"],
        "hi": ["पसीना", "paseena", "thanda paseena"],
        "kn": ["ಬೆವರು", "bevaru"],
    },
    "anxiety": {
        "en": ["anxious", "panic", "worried", "cannot calm down"],
        "hi": ["घबराहट", "ghabrahat", "bechaini"],
        "kn": ["ಆತಂಕ", "atanka", "gabari"],
    },
    "allergic_reaction": {
        "en": ["allergic reaction", "allergy", "swelling of lips", "swollen face"],
        "hi": ["एलर्जी", "allergy", "soojan"],
        "kn": ["ಅಲರ್ಜಿ", "allergy", "bavu"],
    },
    "wheeze": {
        "en": ["wheezing", "whistling in chest"],
        "hi": ["सीटी की आवाज", "seeti ki awaz"],
        "kn": ["ಶಬ್ದ", "usiralli shabda"],
    },
    "vaginal_bleeding": {
        "en": ["vaginal bleeding", "bleeding down below"],
        "hi": ["योनि से रक्तस्राव", "khoon aa raha hai"],
        "kn": ["ರಕ್ತಸ್ರಾವ", "raktasrava"],
    },
    "pregnancy_related": {
        "en": ["pregnant", "pregnancy", "weeks pregnant", "expecting"],
        "hi": ["गर्भवती", "garbhvati", "pregnant hoon"],
        "kn": ["ಗರ್ಭಿಣಿ", "garbhini"],
    },
    "overdose": {
        "en": ["overdose", "took too many tablets", "swallowed pills", "took poison"],
        "hi": ["ज्यादा गोली", "zyada goli", "zeher"],
        "kn": ["ಹೆಚ್ಚು ಮಾತ್ರೆ", "hechu matre", "visha"],
    },
    "self_harm": {
        "en": ["hurt myself", "self harm", "cut myself", "wanted to die"],
        "hi": ["खुद को नुकसान", "khud ko nuksan"],
        "kn": ["ಆತ್ಮಹತ್ಯೆ", "atmahatye"],
    },
    "breast_lump": {
        "en": ["lump in breast", "breast lump"],
        "hi": ["स्तन में गांठ", "stan mein ganth"],
        "kn": ["ಸ್ತನದಲ್ಲಿ ಗಂಟು", "stanadalli gantu"],
    },
    "ear_pain": {
        "en": ["ear pain", "earache"],
        "hi": ["कान दर्द", "kaan dard"],
        "kn": ["ಕಿವಿ ನೋವು", "kivi novu"],
    },
    "eye_pain": {
        "en": ["eye pain", "painful eye", "red eye"],
        "hi": ["आंख में दर्द", "aankh mein dard"],
        "kn": ["ಕಣ್ಣು ನೋವು", "kannu novu"],
    },
    "dental_pain": {
        "en": ["toothache", "tooth pain", "dental pain"],
        "hi": ["दांत दर्द", "daant dard"],
        "kn": ["ಹಲ್ಲು ನೋವು", "hallu novu"],
    },
}

#: Negation cues per language. A negated symptom is recorded as a negation, not
#: silently dropped — "no chest pain" is clinically informative.
NEGATIONS = {
    "en": ["no", "not", "without", "denies", "never", "none"],
    "hi": ["nahi", "nahin", "नहीं", "na", "bilkul nahi"],
    "kn": ["illa", "ಇಲ್ಲ", "iralla"],
}

#: Intensifiers, which raise the assessed severity of a reported symptom.
SEVERITY_WORDS = {
    "en": ["severe", "worst", "unbearable", "terrible", "excruciating", "very bad", "extreme"],
    "hi": ["bahut", "tez", "बहुत", "तेज", "zyada", "asahaniya"],
    "kn": ["tumba", "ತುಂಬಾ", "jasti", "ಜಾಸ್ತಿ", "vipareeta"],
}

LANGUAGE_CODES = {"en-IN": "en", "hi-IN": "hi", "kn-IN": "kn"}

#: Honest declaration of lexicon depth. English has the richest coverage, so a
#: Kannada transcript that matches nothing is more likely to be our gap than the
#: patient's silence — and the confidence score says so.
LANGUAGE_COVERAGE = {"en": 0.95, "hi": 0.72, "kn": 0.68}

_ONSET_PATTERNS = [
    (re.compile(r"(\d+)\s*(hour|hr|hours|ghante|ganta|ಗಂಟೆ)", re.I), 1.0),
    (re.compile(r"(\d+)\s*(day|days|din|dina|ದಿನ)", re.I), 24.0),
    (re.compile(r"(\d+)\s*(week|weeks|hafte|vara|ವಾರ)", re.I), 168.0),
    (re.compile(r"(\d+)\s*(minute|minutes|min|mins)", re.I), 1 / 60),
]


@dataclass
class ExtractionResult:
    symptoms: list[str]
    negations: list[str]
    matched_terms: list[dict[str, Any]]
    unmapped_terms: list[str]
    severity_words: list[str]
    onset_hours: float | None
    extraction_confidence: float
    gloss: str
    language: str


#: Marker standing in for punctuation that ends a clause. Kept through
#: normalisation because "no chest, abdominal pain" and "no chest abdominal pain"
#: mean different things, and dropping the comma loses the difference.
_BOUNDARY = "|"

#: Words that close one clause and open another. A negation does not reach across
#: these: in "chest pain but no fever", the "no" belongs to the fever.
_CLAUSE_BOUNDARIES = {
    _BOUNDARY,
    "but", "however", "though", "although", "only", "except",
    "lekin", "par", "magar", "aur", "phir",
    "aadare", "mattu", "adare",
}

#: How far a negation cue reaches. Short on purpose — long windows are how a
#: negation silently swallows a symptom it was never attached to.
_NEG_LOOKBACK_TOKENS = 4
_NEG_LOOKAHEAD_TOKENS = 2


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = text.lower()
    # Preserve clause-ending punctuation as an explicit token before stripping.
    text = re.sub(r"[,;:.!?]+", f" {_BOUNDARY} ", text)
    text = re.sub(r"[^\w\sऀ-ॿಀ-೿|]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


#: Words permitted to sit between the words of a lexicon phrase, so "face is
#: drooping" still matches the entry "face drooping". A closed list rather than a
#: wildcard gap: allowing arbitrary tokens would let "no chest, abdominal pain"
#: match "chest pain" across the comma.
_FILLERS = [
    "is", "are", "was", "were", "be", "been", "am", "feels", "feeling", "felt",
    "my", "the", "a", "an", "of", "in", "very", "so", "really", "quite",
    "hai", "ho", "hua", "hui", "raha", "rahi", "rha", "mein", "me", "ka", "ki", "ke",
    "ide", "iruttade", "agide", "ittu", "ondu",
]
_FILLER_GAP = r"\s+(?:(?:" + "|".join(_FILLERS) + r")\s+)*"


def _phrase_pattern(phrase: str) -> re.Pattern:
    """Compile a lexicon phrase into a whole-word pattern tolerant of filler words."""
    words = [re.escape(word) for word in phrase.split() if word]
    if not words:
        return re.compile(r"(?!)")
    body = _FILLER_GAP.join(words)
    # Devanagari and Kannada have no ASCII word boundaries, so guard with
    # lookarounds on whitespace/string edges instead of \b.
    return re.compile(rf"(?<![\w])(?:{body})(?![\w])")


#: Languages where negation follows what it negates ("bukhar nahi", "novu illa")
#: rather than preceding it ("no fever"). Getting this wrong silently inverts the
#: clinical meaning of a sentence, which is worse than failing to parse it.
_POST_NEGATING = {"hi", "kn"}


def _tokens_until_boundary(text: str, limit: int, *, reverse: bool) -> list[str]:
    """Tokens adjacent to a match, stopping at the first clause boundary."""
    tokens = text.split()
    if reverse:
        tokens = tokens[::-1]

    collected: list[str] = []
    for token in tokens[:limit]:
        if token in _CLAUSE_BOUNDARIES:
            break
        collected.append(token)
    return collected


def _is_negated(normalised: str, start: int, end: int, language: str) -> bool:
    """Decide whether a matched symptom is negated.

    Two things make this harder than scanning for "no". English negates before the
    symptom ("no fever"); Hindi and Kannada negate after it ("bukhar nahi",
    "jvara illa"). Both directions are checked for those languages, because
    code-switched speech mixes the orders freely within one sentence.

    More importantly, a negation must not reach across a clause boundary. In
    "chest pain but no fever" the "no" belongs to the fever, and a window that
    simply counted characters would quietly negate the chest pain — turning the
    most urgent symptom in the sentence into an explicit denial of it. That is a
    silent, dangerous failure, so the window is short and stops at conjunctions
    and punctuation.
    """
    cues = {_normalise(cue) for cue in NEGATIONS.get(language, []) + NEGATIONS["en"]}
    cues.discard("")

    windows = [_tokens_until_boundary(normalised[:start], _NEG_LOOKBACK_TOKENS, reverse=True)]
    if language in _POST_NEGATING:
        windows.append(_tokens_until_boundary(normalised[end:], _NEG_LOOKAHEAD_TOKENS, reverse=False))

    return any(token in cues for window in windows for token in window)


def extract(text: str, language: str = "en-IN", asr_confidence: float = 0.9) -> ExtractionResult:
    """Map a free-text or dictated utterance onto the controlled symptom vocabulary."""
    lang = LANGUAGE_CODES.get(language, "en")
    normalised = _normalise(text)

    symptoms: list[str] = []
    negations: list[str] = []
    matched: list[dict[str, Any]] = []
    consumed_spans: list[tuple[int, int]] = []

    for symptom, by_language in LEXICON.items():
        # Search this language first, then fall back to English: code-switching is
        # the norm rather than the exception in Indian emergency departments, and a
        # patient speaking Kannada may still say "chest pain".
        phrases = [(p, lang) for p in by_language.get(lang, [])]
        if lang != "en":
            phrases += [(p, "en") for p in by_language.get("en", [])]

        # Every occurrence of every phrase is examined, not just the first. A
        # patient who says "no chest pain — actually, chest pain now" has both, and
        # stopping at the first match would record only the denial.
        occurrences: list[dict[str, Any]] = []
        for phrase, phrase_language in phrases:
            needle = _normalise(phrase)
            if not needle:
                continue
            for found in _phrase_pattern(needle).finditer(normalised):
                position, end = found.start(), found.end()
                occurrences.append(
                    {
                        "symptom": symptom,
                        "matchedPhrase": phrase,
                        "phraseLanguage": phrase_language,
                        "negated": _is_negated(normalised, position, end, lang),
                        # A term found only via the English fallback is weaker
                        # evidence in a non-English utterance.
                        "crossLanguageMatch": phrase_language != lang,
                        "_span": (position, end),
                    }
                )

        if not occurrences:
            continue

        # A contradiction resolves toward the symptom. If any mention is affirmed,
        # the symptom is present: "I said no earlier but yes now" must not be read
        # as reassurance.
        affirmed = [o for o in occurrences if not o["negated"]]
        chosen = affirmed[0] if affirmed else occurrences[0]

        for occurrence in occurrences:
            consumed_spans.append(occurrence.pop("_span"))
        matched.append(chosen)

        if chosen["negated"]:
            negations.append(symptom)
        else:
            symptoms.append(symptom)

    severity_words = [
        word
        for word in SEVERITY_WORDS.get(lang, []) + SEVERITY_WORDS["en"]
        if _normalise(word) and _normalise(word) in normalised
    ]

    onset_hours = None
    for pattern, multiplier in _ONSET_PATTERNS:
        found = pattern.search(text or "")
        if found:
            onset_hours = round(float(found.group(1)) * multiplier, 2)
            break

    # Tokens nobody claimed. Surfaced to the nurse verbatim rather than discarded:
    # a word we failed to understand is a reason to look, not a reason to assume
    # nothing was said.
    covered = set()
    for start, end in consumed_spans:
        covered.update(range(start, end))
    leftover = "".join(" " if index in covered else char for index, char in enumerate(normalised))
    stopwords = {
        "i", "have", "has", "am", "is", "are", "the", "a", "an", "my", "me", "and", "of", "to",
        "in", "for", "since", "from", "with", "it", "he", "she", "they", "was", "were", "very",
        "mein", "hai", "ho", "raha", "rahi", "se", "ka", "ki", "ke", "aa", "na",
        "ide", "illa", "na", "nanu", "nanage", "tumba",
    }
    unmapped = sorted(
        {
            token
            for token in leftover.split()
            if len(token) > 2
            and token not in stopwords
            and token != _BOUNDARY
            and not token.isdigit()
        }
    )

    # --- confidence ---
    # Three things make an extraction weak: we heard the audio poorly, our lexicon
    # for this language is thin, or most of what was said went unrecognised.
    coverage = LANGUAGE_COVERAGE.get(lang, 0.6)
    token_count = max(len(normalised.split()), 1)
    recognised_ratio = min(1.0, (token_count - len(unmapped)) / token_count)
    cross_language_penalty = 1.0 - 0.15 * (
        sum(1 for m in matched if m["crossLanguageMatch"]) / max(len(matched), 1)
    )
    found_something = 1.0 if matched else 0.45

    extraction_confidence = round(
        max(0.05, min(1.0, coverage * (0.45 + 0.55 * recognised_ratio) * cross_language_penalty * found_something)),
        3,
    )

    gloss_parts = [m["symptom"].replace("_", " ") for m in matched if not m["negated"]]
    gloss_negated = [f"no {m['symptom'].replace('_', ' ')}" for m in matched if m["negated"]]
    gloss = "; ".join(gloss_parts + gloss_negated) or "(nothing recognised)"

    return ExtractionResult(
        symptoms=symptoms,
        negations=negations,
        matched_terms=matched,
        unmapped_terms=unmapped,
        severity_words=severity_words,
        onset_hours=onset_hours,
        extraction_confidence=extraction_confidence,
        gloss=gloss,
        language=language,
    )
