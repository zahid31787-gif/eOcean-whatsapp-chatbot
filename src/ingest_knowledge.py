import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=True)

MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-2")
DIMENSIONS = int(os.getenv("GEMINI_EMBEDDING_DIMENSIONS", "1536"))


def get_clients():
    api_key = os.getenv("GEMINI_API_KEY")
    url = os.getenv("SUPABASE_URL")
    secret = os.getenv("SUPABASE_SECRET_KEY")

    if not all([api_key, url, secret]):
        raise ValueError("Missing credentials in .env")

    return (
        genai.Client(api_key=api_key),
        create_client(url.strip(), secret.strip())
    )


def load_chunks(file_path):
    chunks = []

    with open(file_path, "r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            if not line.strip():
                continue
            try:
                chunks.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"Invalid JSON at line {line_number}: {error}"
                )

    return chunks


def validate_all_chunks(chunks):
    if not chunks:
        raise ValueError("No chunks found.")

    ids = set()

    for number, chunk in enumerate(chunks, start=1):
        required = [
            "chunk_id", "source", "audience",
            "approval_status", "retrieval_status", "text"
        ]

        for field in required:
            if not chunk.get(field):
                raise ValueError(
                    f"Chunk {number}: missing {field}"
                )

        if chunk["chunk_id"] in ids:
            raise ValueError(
                f"Duplicate chunk ID: {chunk['chunk_id']}"
            )

        ids.add(chunk["chunk_id"])

        if chunk["audience"] != "public":
            raise ValueError(
                f"Chunk {chunk['chunk_id']} is not public."
            )

        if chunk["approval_status"] != "company-verified":
            raise ValueError(
                f"Chunk {chunk['chunk_id']} is not company-verified."
            )

        if chunk["retrieval_status"] != "approved":
            raise ValueError(
                f"Chunk {chunk['chunk_id']} is not approved for retrieval."
            )

    print(f"Pre-upload validation passed: {len(chunks)} chunks.")


def generate_embedding(client, content):
    result = client.models.embed_content(
        model=MODEL,
        contents=content,
        config=types.EmbedContentConfig(
            output_dimensionality=DIMENSIONS
        )
    )

    values = result.embeddings[0].values

    if len(values) != DIMENSIONS:
        raise ValueError("Unexpected embedding dimensions.")

    return values


def ingest_file(file_path):
    file_path = Path(file_path)

    if not file_path.is_absolute():
        file_path = ROOT / file_path

    if not file_path.exists():
        raise FileNotFoundError(file_path)

    chunks = load_chunks(file_path)

    # Validate every chunk before contacting external services.
    validate_all_chunks(chunks)

    gemini, supabase = get_clients()

    records = []

    # Generate all embeddings before uploading any records.
    for number, chunk in enumerate(chunks, start=1):
        content = chunk["text"]

        embedding = generate_embedding(gemini, content)

        records.append({
            "chunk_id": chunk["chunk_id"],
            "source": chunk["source"],
            "source_file": chunk.get("source_file"),
            "section": chunk.get("section"),
            "audience": chunk["audience"],
            "approval_status": chunk["approval_status"],
            "retrieval_status": chunk["retrieval_status"],
            "content": content,
            "metadata": chunk.get("metadata", {}),
            "embedding": embedding
        })

        print(f"Embedded {number}/{len(chunks)}")

    # Upload records in one batch.
    result = supabase.table("knowledge_chunks").upsert(
        records,
        on_conflict="chunk_id"
    ).execute()

    print(f"Successfully uploaded {len(records)} approved chunks.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(
            "Usage: py src/ingest_knowledge.py <approved-jsonl-file>"
        )
        sys.exit(1)

    try:
        ingest_file(sys.argv[1])
    except Exception as error:
        print(f"INGESTION FAILED: {error}")
        sys.exit(1)
