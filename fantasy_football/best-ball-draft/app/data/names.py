"""
Shared player-name normalization for cross-source matching.

Every data source spells players differently.  DraftKings supplies the player pool;
Sleeper, ESPN and FantasyPros supply the projections and rankings we match onto it.
Punctuation and generational suffixes were already handled, but the sources also
disagree on given names — DraftKings says "Nick Singleton" and "Kenneth Gainwell"
while all three projection sources say "Nicholas Singleton" and "Kenny Gainwell".

That mismatch is expensive and silent: an unmatched player falls through to V2's
ADP-implied estimate (mean x 0.92, availability 0.80, no ECR blend) and is scored as
a generic body at his draft slot instead of on his actual projection.  Gainwell went
at ADP 97 — a round-8 pick valued on nothing.

Canonicalising nicknames to their formal form fixes both directions at once, since
the same function normalizes both sides of every lookup.
"""
import re

# Short form -> formal form. Only entries where the short form is unambiguous;
# "Alex" is deliberately absent because it maps to both Alexander and Alexis.
NICKNAMES = {
    'nick': 'nicholas',    'kenny': 'kenneth',    'mike': 'michael',
    'chris': 'christopher', 'josh': 'joshua',     'matt': 'matthew',
    'rob': 'robert',       'bob': 'robert',       'bobby': 'robert',
    'will': 'william',     'bill': 'william',     'billy': 'william',
    'tony': 'anthony',     'ben': 'benjamin',     'dan': 'daniel',
    'danny': 'daniel',     'joe': 'joseph',       'joey': 'joseph',
    'jim': 'james',        'jimmy': 'james',      'tom': 'thomas',
    'tommy': 'thomas',     'zach': 'zachary',     'zack': 'zachary',
    'cam': 'cameron',      'gabe': 'gabriel',     'nate': 'nathaniel',
    'sam': 'samuel',       'tim': 'timothy',      'ted': 'theodore',
    'greg': 'gregory',     'jeff': 'jeffrey',     'steve': 'steven',
    'dave': 'david',       'ed': 'edward',        'eddie': 'edward',
    'ron': 'ronald',       'rick': 'richard',     'ricky': 'richard',
    'pat': 'patrick',      'andy': 'andrew',      'drew': 'andrew',
    'charlie': 'charles',  'jake': 'jacob',       'tyler': 'tyler',
}

_SUFFIX_RE = re.compile(r"\b(jr\.?|sr\.?|ii|iii|iv|v)\b")
_PUNCT_RE = re.compile(r"[^a-z ]")


def normalize_name(name: str) -> str:
    """
    Lowercase, drop punctuation and generational suffixes, and canonicalise a
    nickname first name to its formal form.

    Only the FIRST token is canonicalised — surnames like "Nix" or "Metcalf" must
    never be rewritten, and a nickname appearing as a surname is not a nickname.
    """
    name = (name or '').lower()
    name = _SUFFIX_RE.sub('', name)
    name = _PUNCT_RE.sub('', name)
    parts = name.split()
    if not parts:
        return ''
    parts[0] = NICKNAMES.get(parts[0], parts[0])
    return ' '.join(parts)
