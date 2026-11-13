from pathlib import Path
import json
import re

# Project directory
BASE_DIR = Path(__file__).resolve().parent.parent

# Extracted source documents
COMPANY_FILE = BASE_DIR / "extracted-text" / "company-profile-extracted.txt"
HANDBOOK_FILE = BASE_DIR / "extracted-text" / "employee-handbook-extracted.txt"

# Output directory
OUTPUT_DIR = BASE_DIR / "knowledge-base" / "drafts"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Chunk settings
MAX_CHARS = 1200
OVERLAP = 150


def split_into_sections(content):
    """Separate extracted content by original slide or page."""

    pattern = r"(?m)^((?:SLIDE|PAGE) \d+)\s*$"
    matches = list(re.finditer(pattern, content))

    sections = []

    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(content)

        section_text = content[start:end]

        # Remove separator lines
        section_text = re.sub(r"(?m)^={10,}\s*$", "", section_text)
        section_text = section_text.strip()

        if section_text:
            sections.append({
                "section": match.group(1),
                "text": section_text
            })

    return sections


def split_into_chunks(text):
    """Divide text into overlapping chunks."""

    text = re.sub(r"\s+", " ", text).strip()

    if not text:
        return []

    chunks = []
    start = 0

    while start < len(text):
        end = min(start + MAX_CHARS, len(text))

        if end < len(text):
            boundary = text.rfind(" ", start + int(MAX_CHARS * 0.7), end)

            if boundary > start:
                end = boundary

        chunk = text[start:end].strip()

        if chunk:
            chunks.append(chunk)

        if end >= len(text):
            break

        start = max(start + 1, end - OVERLAP)

    return chunks


def process_document(
    input_file,
    output_file,
    source_name,
    audience,
    approval_status,
    retrieval_status
):
    """Create searchable draft chunks with source metadata."""

    if not input_file.exists():
        print(f"ERROR: Source file not found: {input_file}")
        return

    content = input_file.read_text(encoding="utf-8")
    sections = split_into_sections(content)

    records = []
    chunk_number = 0

    for section in sections:
        chunks = split_into_chunks(section["text"])

        for chunk in chunks:
            chunk_number += 1

            record = {
                "chunk_id": f"{source_name}-{chunk_number:04d}",
                "source": source_name,
                "source_file": input_file.name,
                "section": section["section"],
                "audience": audience,
                "approval_status": approval_status,
                "retrieval_status": retrieval_status,
                "text": chunk
            }

            records.append(record)

    with output_file.open("w", encoding="utf-8") as file:
        for record in records:
            file.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"\nSource: {source_name}")
    print(f"Sections processed: {len(sections)}")
    print(f"Chunks created: {len(records)}")
    print(f"Output: {output_file}")


if __name__ == "__main__":

    print("Preparing Eocean knowledge documents...")

    process_document(
        input_file=COMPANY_FILE,
        output_file=OUTPUT_DIR / "company-profile-chunks.jsonl",
        source_name="company-profile",
        audience="public-candidate",
        approval_status="factual-verification-required",
        retrieval_status="do-not-index-until-verified"
    )

    process_document(
        input_file=HANDBOOK_FILE,
        output_file=OUTPUT_DIR / "employee-handbook-chunks.jsonl",
        source_name="employee-handbook",
        audience="section-review-required",
        approval_status="mentor-approved-source",
        retrieval_status="do-not-index-until-section-reviewed"
    )

    print("\nKnowledge preparation finished.")