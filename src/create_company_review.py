import json
from pathlib import Path

source = Path("knowledge-base/drafts/company-profile-chunks.jsonl")
output = Path("knowledge-base/pending-review/company-profile-review.md")

rows = [
    json.loads(line)
    for line in source.read_text(encoding="utf-8").splitlines()
]

lines = [
    "# Company Profile – Factual Review",
    "",
    "**Status:** Pending factual verification and approval",
    ""
]

for row in rows:
    lines.extend([
        "## " + row["section"] + " – " + row["chunk_id"],
        "",
        row["text"],
        "",
        "---",
        ""
    ])

output.write_text("\n".join(lines), encoding="utf-8")

print("Created:", output)
print("Sections:", len(rows))
