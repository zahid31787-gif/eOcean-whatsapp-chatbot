from pathlib import Path
from pptx import Presentation
from pypdf import PdfReader

# Project directory
BASE_DIR = Path(__file__).resolve().parent.parent

# Output directory
OUTPUT_DIR = BASE_DIR / "extracted-text"
OUTPUT_DIR.mkdir(exist_ok=True)

# Source documents
PPTX_FILE = BASE_DIR / "documents" / "company" / "eOcean_Company_Profile_WhatsApp_Chatbot.pptx"
PDF_FILE = BASE_DIR / "documents" / "policies" / "Employee Handbook- EO.pdf"


def extract_powerpoint():
    print("\nExtracting PowerPoint...")

    presentation = Presentation(str(PPTX_FILE))
    extracted_content = []

    for slide_number, slide in enumerate(presentation.slides, start=1):
        extracted_content.append(f"\n{'=' * 60}")
        extracted_content.append(f"SLIDE {slide_number}")
        extracted_content.append("=" * 60)

        for shape in slide.shapes:
            if shape.has_text_frame:
                text = shape.text.strip()
                if text:
                    extracted_content.append(text)

            if shape.has_table:
                for row in shape.table.rows:
                    cells = [cell.text.strip() for cell in row.cells]
                    extracted_content.append(" | ".join(cells))

    output_file = OUTPUT_DIR / "company-profile-extracted.txt"
    output_file.write_text(
        "\n".join(extracted_content),
        encoding="utf-8"
    )

    print(f"PowerPoint extraction complete: {output_file}")


def extract_pdf():
    print("\nExtracting Employee Handbook PDF...")

    reader = PdfReader(str(PDF_FILE))
    extracted_content = []

    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text()

        extracted_content.append(f"\n{'=' * 60}")
        extracted_content.append(f"PAGE {page_number}")
        extracted_content.append("=" * 60)

        if text:
            extracted_content.append(text)
        else:
            extracted_content.append("[No extractable text on this page]")

    output_file = OUTPUT_DIR / "employee-handbook-extracted.txt"
    output_file.write_text(
        "\n".join(extracted_content),
        encoding="utf-8"
    )

    print(f"PDF extraction complete: {output_file}")


if __name__ == "__main__":
    if not PPTX_FILE.exists():
        print(f"ERROR: PowerPoint not found: {PPTX_FILE}")
    else:
        extract_powerpoint()

    if not PDF_FILE.exists():
        print(f"ERROR: PDF not found: {PDF_FILE}")
    else:
        extract_pdf()

    print("\nExtraction process finished.")