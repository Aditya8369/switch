"""What an attached file is checked as, and how a message's files are judged
together. The two call sites (inbound bridge, agent send_media) are tested
separately; this covers the decisions they share."""

import io
import zipfile

import pytest
from pypdf import PdfWriter

from switch_core.trust import attachments
from switch_core.trust.attachments import (
    TRUST_FILE_TEXT_LIMIT,
    check_attachments,
    extract_file_text,
)
from switch_core.trust.client import TrustCheckResult, TrustFinding


class _ContentTrustClient:
    """Blocks text containing FORBIDDEN, redacts text containing SECRET,
    flags text containing FLAG, and allows the rest. Records what it saw."""

    def __init__(self) -> None:
        self.checked: list[tuple[str, str]] = []

    async def is_active(self) -> bool:
        return True

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        self.checked.append((role, content))
        finding = (TrustFinding(category="test", detector_name="t", severity="high"),)
        if "FORBIDDEN" in content:
            return TrustCheckResult("blocked", "p", "policy", finding)
        if "SECRET" in content:
            return TrustCheckResult(
                "redacted", "p", "policy", finding, content.replace("SECRET", "x")
            )
        if "FLAG" in content:
            return TrustCheckResult("alerted", "p", "policy", finding)
        return TrustCheckResult("ok", "p", "policy")


@pytest.mark.parametrize(
    ("mimetype", "data"),
    [
        ("text/plain", b"hello"),
        ("application/json", b'{"a": 1}'),
        ("application/x-yaml", b"a: 1"),
        ("text/csv; charset=utf-8", b"a,b\n1,2"),
        ("application/octet-stream", b"print('hi')"),
        ("image/svg+xml", b"<svg></svg>"),
    ],
)
def test_text_like_files_are_read_as_text(mimetype: str, data: bytes) -> None:
    file_text = extract_file_text(data, mimetype, "file")
    assert file_text.text == data.decode()
    assert file_text.unreadable_reason is None


@pytest.mark.parametrize(
    ("mimetype", "data"),
    [
        ("image/png", b"\x89PNG\r\n"),
        # Even when the bytes happen to decode, a PDF is never checked as text.
        ("application/pdf", b"%PDF-1.4 plain ascii"),
        (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            b"PK\x03\x04",
        ),
        ("application/zip", b"PK\x03\x04"),
        ("application/octet-stream", b"\xff\xfe\x00\x01"),
        ("text/plain", b"nul\x00inside"),
    ],
)
def test_files_without_readable_text_are_never_sent_as_text(
    mimetype: str, data: bytes
) -> None:
    file_text = extract_file_text(data, mimetype, "file")
    assert file_text.text is None
    assert file_text.unreadable_reason


def test_long_text_is_cut_to_the_limit() -> None:
    file_text = extract_file_text(
        b"a" * (TRUST_FILE_TEXT_LIMIT + 5), "text/plain", "big.log"
    )
    assert file_text.text is not None
    assert len(file_text.text) == TRUST_FILE_TEXT_LIMIT
    assert file_text.checked_part == "the first 20,000 characters"


async def test_a_blocked_file_blocks_and_names_the_file() -> None:
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="user",
        files=[(b"fine", "a.txt", "text/plain"), (b"FORBIDDEN", "b.txt", "text/plain")],
        room_id="room-1",
    )
    assert verdict.blocked
    assert any("b.txt" in reason for reason in verdict.block_reasons)
    assert sorted(content for _, content in client.checked) == ["FORBIDDEN", "fine"]


async def test_a_redacted_file_blocks_because_a_file_cannot_be_redacted() -> None:
    verdict = await check_attachments(
        _ContentTrustClient(),  # type: ignore[arg-type]
        role="user",
        files=[(b"my SECRET", "notes.md", "text/markdown")],
        room_id="room-1",
    )
    assert verdict.blocked
    assert verdict.block is not None and verdict.block.outcome == "blocked"
    assert "cannot be redacted" in verdict.block_reasons[0]


async def test_unreadable_flagged_and_long_files_each_carry_a_note() -> None:
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="assistant",
        files=[
            (b"\x89PNG", "cat.png", "image/png"),
            (b"FLAG", "f.txt", "text/plain"),
            (b"b" * (TRUST_FILE_TEXT_LIMIT + 1), "long.log", "text/plain"),
        ],
        room_id="room-1",
    )
    assert not verdict.blocked
    assert verdict.flagged
    notes = "\n".join(verdict.notes)
    assert "did not check cat.png" in notes
    assert "flagged f.txt" in notes
    assert (
        "checked only the first 20,000 characters of long.log; the rest was not checked"
        in notes
    )
    # The image's bytes were never sent.
    assert all(role == "assistant" for role, _ in client.checked)
    assert len(client.checked) == 2


async def test_unchecked_files_block_when_the_policy_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(attachments, "RELAY_UNCHECKED_FILES", False)
    verdict = await check_attachments(
        _ContentTrustClient(),  # type: ignore[arg-type]
        role="user",
        files=[(b"\x89PNG", "cat.png", "image/png")],
        room_id="room-1",
    )
    assert verdict.blocked
    assert "cat.png could not be checked" in verdict.block_reasons[0]


_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _docx(body: str, *, header: str | None = None, padding: int = 0) -> bytes:
    """A minimal Word document: just the parts the reader looks at."""

    def part(text: str) -> str:
        return (
            f'<w:document xmlns:w="{_W_NS}"><w:body><w:p><w:r>'
            f"<w:t>{text}</w:t></w:r></w:p>{'<w:p/>' * padding}</w:body></w:document>"
        )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", part(body))
        if header is not None:
            archive.writestr("word/header1.xml", part(header))
    return buffer.getvalue()


def _pdf(*pages: str | None) -> bytes:
    """A minimal PDF, one page per entry: a line of Helvetica text, or a
    page with no text layer at all (None), as a scanned page has."""
    count = len(pages)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(count))
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {count} >>",
    ]
    font = 3 + 2 * count
    for i, text in enumerate(pages):
        content = f"BT /F1 12 Tf 72 712 Td ({text}) Tj ET" if text else ""
        objects.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font} 0 R >> >> /Contents {4 + 2 * i} 0 R >>"
        )
        objects.append(f"<< /Length {len(content)} >>\nstream\n{content}\nendstream")
    objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return out


_DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def test_a_word_document_is_read_body_and_header() -> None:
    file_text = extract_file_text(
        _docx("the body", header="the header"), _DOCX_TYPE, "memo.docx"
    )
    assert file_text.text is not None
    assert "the body" in file_text.text
    assert "the header" in file_text.text


def test_a_word_document_is_recognised_by_extension_alone() -> None:
    file_text = extract_file_text(
        _docx("hello"), "application/octet-stream", "memo.docx"
    )
    assert file_text.text is not None and "hello" in file_text.text


@pytest.mark.parametrize(
    "data",
    [
        b"PK\x03\x04 not really a zip",
        # A zip without a document body is not a Word document.
        _docx("x").replace(b"word/document.xml", b"word/documenX.xml"),
    ],
)
def test_a_broken_word_document_is_unchecked_not_an_error(data: bytes) -> None:
    file_text = extract_file_text(data, _DOCX_TYPE, "memo.docx")
    assert file_text.text is None
    assert file_text.unreadable_reason == "this Word document could not be read"


def test_a_word_document_declaring_a_dtd_is_refused() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "word/document.xml",
            '<!DOCTYPE x [<!ENTITY a "aaaa">]><w:document xmlns:w="'
            f'{_W_NS}"><w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body>'
            "</w:document>",
        )
    file_text = extract_file_text(buffer.getvalue(), _DOCX_TYPE, "memo.docx")
    assert file_text.text is None


def test_a_word_document_stops_at_the_byte_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A highly compressible document (a zip bomb, in the limit) is only
    # inflated as far as the budget, and says it was checked in part.
    monkeypatch.setattr(attachments, "_DOCX_XML_BYTE_BUDGET", 2_000)
    file_text = extract_file_text(
        _docx("early text", padding=100_000), _DOCX_TYPE, "bomb.docx"
    )
    assert file_text.text is not None and "early text" in file_text.text
    assert file_text.checked_part == "the first 8 MB"


def test_a_word_document_with_no_text_is_unchecked() -> None:
    file_text = extract_file_text(_docx(""), _DOCX_TYPE, "pictures.docx")
    assert file_text.text is None
    assert file_text.unreadable_reason == "no text found in this Word document"


def test_a_pdf_is_read_page_by_page() -> None:
    file_text = extract_file_text(
        _pdf("first page", "second page"), "application/pdf", "doc.pdf"
    )
    assert file_text.text is not None
    assert "first page" in file_text.text
    assert "second page" in file_text.text
    assert file_text.checked_part is None


def test_a_scanned_pdf_with_no_text_is_unchecked_not_clean() -> None:
    file_text = extract_file_text(_pdf(None), "application/pdf", "scan.pdf")
    assert file_text.text is None
    assert "no text found in this PDF" in (file_text.unreadable_reason or "")


def test_a_malformed_pdf_is_unchecked_not_an_error() -> None:
    file_text = extract_file_text(b"%PDF-1.4 garbage", "application/pdf", "x.pdf")
    assert file_text.unreadable_reason == "this PDF could not be read"


def test_an_encrypted_pdf_is_unchecked() -> None:
    writer = PdfWriter()
    writer.add_blank_page(100, 100)
    writer.encrypt("secret")
    buffer = io.BytesIO()
    writer.write(buffer)
    file_text = extract_file_text(buffer.getvalue(), "application/pdf", "x.pdf")
    assert file_text.unreadable_reason == "encrypted PDFs cannot be checked"


def test_a_pdf_past_the_page_limit_says_which_pages_were_checked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(attachments, "_PDF_PAGE_LIMIT", 1)
    file_text = extract_file_text(_pdf("one", "two"), "application/pdf", "x.pdf")
    assert file_text.text is not None and "two" not in file_text.text
    assert file_text.checked_part == "the first 1 of 2 pages"


async def test_blocked_text_inside_a_word_document_or_a_pdf_blocks() -> None:
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="user",
        files=[
            (_docx("FORBIDDEN plan"), "plan.docx", _DOCX_TYPE),
            (_pdf("FORBIDDEN report"), "report.pdf", "application/pdf"),
        ],
        room_id="room-1",
    )
    assert verdict.blocked
    reasons = " ".join(verdict.block_reasons)
    assert "plan.docx was blocked" in reasons
    assert "report.pdf was blocked" in reasons


async def test_a_scanned_pdf_is_relayed_with_a_not_checked_note() -> None:
    verdict = await check_attachments(
        _ContentTrustClient(),  # type: ignore[arg-type]
        role="user",
        files=[(_pdf(None), "scan.pdf", "application/pdf")],
        room_id="room-1",
    )
    assert not verdict.blocked
    [note] = verdict.notes
    assert "did not check scan.pdf" in note
