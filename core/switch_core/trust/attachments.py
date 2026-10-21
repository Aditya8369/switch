"""Switch Trust for files: what an attached file is checked as.

Switch Trust only reads text, so a file is checked through the text it
carries: a text-like file (text/*, JSON, YAML, CSV, Markdown, source code, or
anything else that decodes cleanly as UTF-8) as its decoded text, a Word
document (.docx) as the text of its body, headers, footers, notes and
comments, and a PDF as the text of its pages, each up to
`TRUST_FILE_TEXT_LIMIT` characters. Everything else (images, audio, video,
archives, other office formats, binaries, scanned PDFs with no text layer,
files that cannot be parsed) cannot be read here, and `RELAY_UNCHECKED_FILES`
decides what happens to it.

A file cannot be redacted the way a message can, so a REDACTED verdict on a
file's text blocks the message it came with, the same as BLOCKED.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from typing import IO
from xml.parsers import expat

from pypdf import PdfReader

from switch_core.sessions.attachments import normalise_mime_type
from switch_core.trust.client import (
    Role,
    TrustCheckResult,
    TrustClient,
    TrustFinding,
    check_message,
)

logger = logging.getLogger(__name__)

# What Switch does with a file Switch Trust cannot read (an image, a scanned
# PDF, an archive). True relays it with a visible "not checked" note on the
# message and a WARNING in the log; False blocks the whole message instead.
# This is the one place that choice is made, for people and agents alike.
RELAY_UNCHECKED_FILES = True

# The most text taken from one file for a check. Anything in a file past this
# point reaches agents WITHOUT being checked by Switch Trust. The cap exists
# because a check has to answer inside `switch_trust_timeout_seconds` (2s by
# default) and Switch Trust is built for a message's worth of text, not a
# whole log or book; a slower check would fail open as "could not check"
# anyway. Every file cut here carries a visible note on the message saying so,
# and a WARNING is logged, so the gap is never silent.
TRUST_FILE_TEXT_LIMIT = 20_000

# Bounds on reading documents, so a small upload cannot cost unbounded work:
# a .docx is a zip, and its XML is read through a decompressing stream that
# stops after this many bytes (a zip bomb inflates no further than this); a
# PDF is read page by page, up to this many pages.
_DOCX_XML_BYTE_BUDGET = 8 * 1024 * 1024
_PDF_PAGE_LIMIT = 200

_DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_PDF_TYPE = "application/pdf"

# The parts of a .docx that carry text a reader sees, body first.
_DOCX_TEXT_PART = re.compile(
    r"word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml"
)
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# Types never worth decoding: Switch has no way to read their text, and a
# lucky UTF-8 decode of one would check bytes that mean nothing as text.
_TEXTLESS_KINDS: tuple[tuple[str, str], ...] = (
    ("image/", "images cannot be checked"),
    ("audio/", "audio cannot be checked"),
    ("video/", "video cannot be checked"),
    ("font/", "fonts cannot be checked"),
    ("application/msword", "older Word documents (.doc) cannot be checked"),
    (
        "application/vnd.openxmlformats-officedocument.",
        "Office documents other than Word cannot be checked",
    ),
    ("application/vnd.ms-", "Office documents other than Word cannot be checked"),
    ("application/vnd.oasis.opendocument.", "OpenDocument files cannot be checked"),
    ("application/zip", "archives cannot be checked"),
    ("application/gzip", "archives cannot be checked"),
    ("application/x-tar", "archives cannot be checked"),
    ("application/x-7z-compressed", "archives cannot be checked"),
    ("application/x-rar-compressed", "archives cannot be checked"),
    ("application/vnd.rar", "archives cannot be checked"),
    ("application/x-bzip2", "archives cannot be checked"),
    ("application/x-xz", "archives cannot be checked"),
)

# Image types that are text underneath, and so are checked as text.
_TEXT_IMAGES = frozenset({"image/svg+xml"})


@dataclass(frozen=True)
class FileText:
    """The text a file is checked as, or why it has none.

    Exactly one of `text` and `unreadable_reason` is set. `checked_part` is
    set when only part of the file was read ("the first 20,000 characters"),
    for the note that says the rest was not checked."""

    text: str | None
    checked_part: str | None = None
    unreadable_reason: str | None = None


def _unreadable(reason: str) -> FileText:
    return FileText(text=None, unreadable_reason=reason)


def _capped(text: str, checked_part: str | None = None) -> FileText:
    if len(text) > TRUST_FILE_TEXT_LIMIT:
        return FileText(
            text=text[:TRUST_FILE_TEXT_LIMIT],
            checked_part=f"the first {TRUST_FILE_TEXT_LIMIT:,} characters",
        )
    return FileText(text=text, checked_part=checked_part)


def _docx_part_text(stream: IO[bytes], budget: int) -> tuple[str, int, bool]:
    """The visible text of one WordprocessingML part, read through
    `stream` (a decompressing zip member) a chunk at a time. Returns the
    text, the bytes read, and whether it stopped before the end of the part
    (byte budget or text cap reached)."""
    parser = expat.ParserCreate(namespace_separator="}")
    pieces: list[str] = []
    in_text = False
    length = 0

    def refuse_dtd(*_args: object) -> None:
        # Word never writes a DTD; one here is a crafted file (entity
        # expansion), not a document. Expat reports the declaration itself,
        # so it is caught whatever the encoding or chunk boundaries.
        raise ValueError("document declares a DTD")

    def start(tag: str, _attrs: object) -> None:
        nonlocal in_text
        name = "{" + tag
        if name == f"{_W}t":
            in_text = True
        elif name == f"{_W}tab":
            pieces.append("\t")
        elif name == f"{_W}br":
            pieces.append("\n")

    def end(tag: str) -> None:
        nonlocal in_text
        name = "{" + tag
        if name == f"{_W}t":
            in_text = False
        elif name == f"{_W}p":
            pieces.append("\n")

    def text(data: str) -> None:
        nonlocal length
        if in_text:
            pieces.append(data)
            length += len(data)

    parser.StartDoctypeDeclHandler = refuse_dtd
    parser.EntityDeclHandler = refuse_dtd
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    read = 0
    while True:
        chunk = stream.read(min(64 * 1024, budget - read))
        if not chunk:
            stopped_early = bool(stream.read(1))
            if not stopped_early:
                parser.Parse(b"", True)
            return "".join(pieces), read, stopped_early
        read += len(chunk)
        parser.Parse(chunk, False)
        if length > TRUST_FILE_TEXT_LIMIT:
            return "".join(pieces), read, True


def _docx_text(data: bytes) -> FileText:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = sorted(
                (n for n in archive.namelist() if _DOCX_TEXT_PART.fullmatch(n)),
                key=lambda n: (n != "word/document.xml", n),
            )
            if "word/document.xml" not in names:
                return _unreadable("this Word document could not be read")
            pieces: list[str] = []
            budget = _DOCX_XML_BYTE_BUDGET
            stopped_early = False
            for name in names:
                with archive.open(name) as stream:
                    text, read, stopped_early = _docx_part_text(stream, budget)
                pieces.append(text)
                budget -= read
                if stopped_early or budget <= 0:
                    stopped_early = True
                    break
    except (zipfile.BadZipFile, expat.ExpatError, ValueError, OSError, RuntimeError):
        # RuntimeError is what zipfile raises for an encrypted member.
        logger.warning("Could not read text from a Word document", exc_info=True)
        return _unreadable("this Word document could not be read")
    text = "\n".join(p for p in pieces if p)
    if not text.strip():
        return _unreadable("no text found in this Word document")
    if stopped_early and len(text) <= TRUST_FILE_TEXT_LIMIT:
        return FileText(text=text, checked_part="the first 8 MB")
    return _capped(text)


def _pdf_text(data: bytes) -> FileText:
    pieces: list[str] = []
    length = 0
    checked_part: str | None = None
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            return _unreadable("encrypted PDFs cannot be checked")
        page_count = len(reader.pages)
        for number, page in enumerate(reader.pages):
            if number >= _PDF_PAGE_LIMIT:
                checked_part = f"the first {_PDF_PAGE_LIMIT} of {page_count} pages"
                break
            page_text = page.extract_text() or ""
            pieces.append(page_text)
            length += len(page_text)
            if length > TRUST_FILE_TEXT_LIMIT:
                break
    except Exception:
        # pypdf raises a wide and unstable set of errors on malformed input
        # (its own, but also ValueError, KeyError, struct errors); any of
        # them means the same here: this PDF could not be read.
        logger.warning("Could not read text from a PDF", exc_info=True)
        return _unreadable("this PDF could not be read")
    text = "\n".join(pieces)
    if not text.strip():
        # A scanned PDF is pictures of text: nothing to check is not clean.
        return _unreadable("no text found in this PDF, it may be scanned")
    return _capped(text, checked_part)


def extract_file_text(data: bytes, mimetype: str, filename: str) -> FileText:
    """The text Switch Trust should check for one file. Never raw binary:
    anything that is not cleanly text comes back unreadable, with a reason a
    person can read. Documents are recognised by type or file extension,
    since platforms often label them application/octet-stream."""
    kind = normalise_mime_type(mimetype)
    extension = filename.lower().rpartition(".")[2] if "." in filename else ""
    if kind == _DOCX_TYPE or extension == "docx":
        return _docx_text(data)
    if kind == _PDF_TYPE or extension == "pdf" or data.startswith(b"%PDF-"):
        return _pdf_text(data)
    if kind not in _TEXT_IMAGES:
        for prefix, reason in _TEXTLESS_KINDS:
            if kind.startswith(prefix):
                return _unreadable(reason)
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return _unreadable("binary files cannot be checked")
    if "\x00" in text:
        # Valid UTF-8 can still be binary: NUL never appears in real text.
        return _unreadable("binary files cannot be checked")
    return _capped(text)


@dataclass(frozen=True)
class AttachmentsVerdict:
    """What Switch Trust made of a message's files, taken together.

    `blocked` means nothing from the message may be relayed; `block_reasons`
    says why, one plain phrase per file, for the notice, and `block` is the
    verdict to report it under. Otherwise `notes`
    are the visible annotations the message must carry (a file not checked,
    checked only in part, flagged, or not checked because Switch Trust
    failed), and `flagged` is True when one of them is an ALERTED verdict."""

    block: TrustCheckResult | None = None
    block_reasons: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()
    flagged: bool = False

    @property
    def blocked(self) -> bool:
        return self.block is not None


def _categories(result: TrustCheckResult, fallback: str) -> str:
    return ", ".join(sorted({f.category for f in result.findings})) or fallback


async def check_attachments(
    client: TrustClient,
    *,
    role: Role,
    files: Sequence[tuple[bytes, str, str]],
    room_id: str,
) -> AttachmentsVerdict:
    """Check every file in `files` ((data, filename, mimetype) each) against
    Switch Trust, concurrently. Only call this when Switch Trust is on
    (`trust_is_active`): when it is off, no file is read at all."""
    # Off the event loop: parsing a PDF or a Word document is CPU work.
    texts = await asyncio.gather(
        *(
            asyncio.to_thread(extract_file_text, data, mimetype, filename)
            for data, filename, mimetype in files
        )
    )
    extracted = [
        (filename, file_text)
        for (_data, filename, _mimetype), file_text in zip(files, texts)
    ]
    # Indexed by position, not filename: two files in one post can share a name.
    to_check = [
        (index, file_text.text)
        for index, (_filename, file_text) in enumerate(extracted)
        if file_text.text is not None and file_text.text.strip()
    ]
    results = await asyncio.gather(
        *(
            check_message(client, role=role, content=text, room_id=room_id)
            for _index, text in to_check
        )
    )
    checked = {index: result for (index, _), result in zip(to_check, results)}

    block_reasons: list[str] = []
    block_result: TrustCheckResult | None = None
    notes: list[str] = []
    flagged = False
    for index, (filename, file_text) in enumerate(extracted):
        if file_text.unreadable_reason is not None:
            if RELAY_UNCHECKED_FILES:
                logger.warning(
                    "Switch Trust did not check attachment %s (%s); relaying "
                    "it with a note in room %s",
                    filename,
                    file_text.unreadable_reason,
                    room_id,
                )
                notes.append(
                    f"⚠️ _Switch Trust did not check {filename} "
                    f"({file_text.unreadable_reason})._"
                )
            else:
                block_reasons.append(
                    f"{filename} could not be checked ({file_text.unreadable_reason})"
                )
                block_result = block_result or TrustCheckResult(
                    outcome="blocked",
                    policy_id=None,
                    policy_name=None,
                    findings=(
                        TrustFinding(
                            category="unchecked file",
                            detector_name="switch",
                            severity=None,
                        ),
                    ),
                )
            continue
        result = checked.get(index)
        if result is None:
            # Empty or whitespace-only: there is nothing in it to check.
            continue
        if result.outcome == "blocked":
            block_reasons.append(
                f"{filename} was blocked ({_categories(result, 'policy violation')})"
            )
            block_result = block_result or result
            continue
        if result.outcome == "redacted":
            block_reasons.append(
                f"{filename} holds content Switch Trust would redact "
                f"({_categories(result, 'policy violation')}), and a file "
                "cannot be redacted safely"
            )
            block_result = block_result or TrustCheckResult(
                outcome="blocked",
                policy_id=result.policy_id,
                policy_name=result.policy_name,
                findings=result.findings,
            )
            continue
        if result.outcome == "alerted":
            flagged = True
            notes.append(
                f"⚠️ _Switch Trust flagged {filename} (not blocked - "
                f"{_categories(result, 'policy alert')})._"
            )
        elif result.outcome == "errored":
            notes.append(f"⚠️ _Switch Trust could not check {filename}._")
        if file_text.checked_part is not None:
            logger.warning(
                "Switch Trust checked only %s (%d characters) of attachment %s "
                "(%d bytes) in room %s; the rest reaches the room unchecked",
                file_text.checked_part,
                len(file_text.text or ""),
                filename,
                len(files[index][0]),
                room_id,
            )
            notes.append(
                f"⚠️ _Switch Trust checked only {file_text.checked_part} of "
                f"{filename}; the rest was not checked._"
            )

    if block_result is not None:
        return AttachmentsVerdict(
            block=block_result, block_reasons=tuple(block_reasons)
        )
    return AttachmentsVerdict(notes=tuple(notes), flagged=flagged)
