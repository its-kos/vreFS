"""
app/datasets/fair.py

FAIR assessor — a pure function that scores a dataset against
six criteria derived from the F-UJI automated FAIR assessment tool.

No I/O, no database calls, no side effects. Takes a Dataset instance
with already-populated fields, returns a score dict. This makes it
trivial to test and easy to call from anywhere.

The six criteria map to the four FAIR principles:
  F — Findable
  A — Accessible
  I — Interoperable
  R — Reusable

Score shape:
  {
    "f": 0-100,
    "a": 0-100,
    "i": 0-100,
    "r": 0-100,
    "total": 0-100,
    "criteria": {
      "has_pid":          bool,
      "has_description":  bool,
      "has_licence":      bool,
      "has_format":       bool,
      "has_checksum":     bool,
      "has_access_url":   bool,
    }
  }

Each criterion is binary (pass/fail). The four principle scores are
the percentage of their sub-criteria that pass. Total is the mean
of the four principle scores.

Reference: F-UJI automated FAIR assessment tool
https://www.f-uji.net/
"""


def compute_fair_score(dataset) -> dict:
    """
    Score a dataset against six FAIR criteria.

    Called from extract_metadata task after fields are populated.
    Can also be called from perform_update to recompute when
    metadata is edited.

    Parameters
    ----------
    dataset : Dataset
        A Dataset instance with fields already set (not necessarily saved yet).

    Returns
    -------
    dict
        Score dict as described in the module docstring.
    """
    metadata = dataset.metadata or {}

    # ── Evaluate each criterion ───────────────────────────────────────

    # F1 — Has a persistent identifier
    # A PID must exist (minted by mint_internal at registration).
    # We check the pids reverse relation — at scoring time this is
    # always True since PID.mint_internal runs before this task.
    has_pid = dataset.pids.exists()

    # F2 — Has a meaningful description
    # Either dataset.description is non-empty, or dct:description
    # is present in the metadata block set by the researcher.
    description = (
        getattr(dataset, 'description', '') or
        metadata.get('dct:description', '')
    )
    has_description = bool(description and description.strip())

    # A1 — Has an access URL in the distribution
    # dcat:distribution must contain at least one entry with
    # a non-empty dcat:accessURL — populated by metadata extraction.
    distributions = metadata.get('dcat:distribution', [])
    has_access_url = any(
        d.get('dcat:accessURL', '').strip()
        for d in distributions
    )

    # I1 — Has a declared format using a standard MIME type
    # Either the top-level format column or dct:format in metadata.
    fmt = dataset.format or metadata.get('dct:format', '')
    has_format = bool(fmt and '/' in fmt)  # valid MIME type has a slash

    # R1 — Has a licence
    # Either the top-level licence column or dct:license in metadata.
    licence = dataset.licence or metadata.get('dct:license', '')
    has_licence = bool(licence and licence.strip())

    # R2 — Has an integrity checksum
    # Either the top-level checksum column or spdx:checksum in metadata.
    checksum = dataset.checksum_sha256 or metadata.get('spdx:checksum', {})
    has_checksum = bool(checksum)

    # ── Compute principle scores ──────────────────────────────────────
    # Each principle gets a percentage score based on its criteria.

    # F: Findable — PID + description (2 criteria)
    f_score = _percent([has_pid, has_description])

    # A: Accessible — access URL (1 criterion)
    a_score = _percent([has_access_url])

    # I: Interoperable — format declared (1 criterion)
    i_score = _percent([has_format])

    # R: Reusable — licence + checksum (2 criteria)
    r_score = _percent([has_licence, has_checksum])

    # Total: mean of four principle scores
    total = round((f_score + a_score + i_score + r_score) / 4)

    return {
        'f':     f_score,
        'a':     a_score,
        'i':     i_score,
        'r':     r_score,
        'total': total,
        'criteria': {
            'has_pid':         has_pid,
            'has_description': has_description,
            'has_access_url':  has_access_url,
            'has_format':      has_format,
            'has_licence':     has_licence,
            'has_checksum':    has_checksum,
        },
    }


def _percent(criteria: list) -> int:
    """Convert a list of booleans to a 0-100 percentage score."""
    if not criteria:
        return 0
    return round(100 * sum(criteria) / len(criteria))