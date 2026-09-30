# OCR Architecture

UROS implements a 7-layer OCR pipeline for document processing.

## Layer Overview

```
Layer 1: Ingestion     → Document upload, format detection, virus scan
Layer 2: Pre-processing → Deskew, denoise, contrast enhancement
Layer 3: OCR Engine     → Tesseract + custom model ensemble
Layer 4: Post-processing → Spell correction, field extraction
Layer 5: Validation     → Cross-field consistency checks
Layer 6: Confidence     → Per-field confidence scoring
Layer 7: Human Review   → Low-confidence fields routed to HIL
```

## Document Types

- **CV/Resume** — PDF, DOCX, images (JPEG, PNG)
- **MCQ Answer Sheets** — Scanned images, PDF
- **Certificates** — Educational certificates, NID cards
- **Application Forms** — Structured government forms

## OCR Pipeline Flow

```
Upload → Format detect → Pre-process → OCR → Extract fields → Validate → Score confidence → Store
                                                                         ↓ (low confidence)
                                                                   HIL Gate → Human review
```

## Configuration

OCR processing is configurable per organization:
- Language packs (Bengali + English)
- Confidence thresholds
- Custom field extractors
- Pre-processing filters

## Storage

Processed documents are stored encrypted at rest (AES-256-GCM) via the `DocumentStorage` interface:
- **Local** — filesystem (development)
- **GCS** — Google Cloud Storage (production)

## Performance

- Target: < 5 seconds per page for standard documents
- Batch processing via queue for large imports
- Parallel page processing within a document
