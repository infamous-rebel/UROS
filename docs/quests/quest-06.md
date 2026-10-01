# Quest 06 — OCR 11-Layer Architecture and Full Parser Extraction

## Overview

Rebuild the entire OCR and document-parsing pipeline as an 11-layer architecture with explicit per-layer contracts, measured accuracy thresholds, and a curated sample corpus. Extract every field that the candidate profile requires. Achieve measurable accuracy improvement over the current single-engine Tesseract implementation.

## Parts

### Part 1: Sample Corpus
- Create `tests/ocr-corpus/` with 80+ samples, ground truth JSON, SVG templates, generator
- Document types: SSC/HSC certificates, NID cards, transcripts, bank forms, MCQ sheets, handwritten forms, mixed Bangla-English
- Verification: `find tests/ocr-corpus/documents -name "*.png" | wc -l` >= 80

### Part 2: Layers 0, 1, 2, 2b (Quality, Preprocess, Layout, Tables)
- Layer 0: Image quality assessment (95% agreement threshold)
- Layer 1: Preprocessing — deskew, denoise, binarize, contrast (90% usability threshold)
- Layer 2: Layout analysis — region detection (85% F1 threshold)
- Layer 2b: Table extraction (80% cell accuracy threshold)

### Part 3: Layers 3, 3b (Recognition, Ensemble Voting)
- Layer 3: Persistent Tesseract workers per script (85% Bangla, 92% English, 70% handwritten)
- Layer 3b: Multi-engine ensemble voting — Tesseract + EasyOCR + PaddleOCR (5% relative improvement)
- Python bridge for EasyOCR/PaddleOCR

### Part 4: Layers 4, 4b (Extraction, Spelling)
- Layer 4: Field extraction with Bangla normalization, fuzzy dictionary (90% field accuracy)
- Layer 4b: Spelling correction with Levenshtein + n-gram LM (30% CER reduction)

### Part 5: Layers 5, 5b (Validation, Forgery Detection)
- Layer 5: Cross-field validation (100% contradiction detection)
- Layer 5b: Forgery detection — font consistency, seal detection, ELA (80% precision, 95% specificity)

### Part 6: Layers 6, 7 (Confidence, Routing)
- Layer 6: Confidence aggregation (90% human agreement)
- Layer 7: Human review routing (95% correct routing)
- Migration 0036: ocr_thresholds JSONB on organizations

### Part 7: Tesseract LSTM Fine-Tuning
- Custom .traineddata per document type
- 5000 training lines per type
- >= 10% relative improvement per document type

### Part 8: Full Parser Agent Rewrite
- parser_agent uses full pipeline, populates all candidate tables
- Transaction-based inserts, audit_log for every row
- POST /api/v1/candidates/:id/reparse endpoint

### Part 9: PDF Rasterization
- pdfjs-dist for PDF → PNG at 300 DPI
- Multi-page support, encrypted PDF rejection

### Part 10: OMR Accuracy Improvements
- K-means clustering for bubble detection
- Multi-mark detection (bubble, tick, cross, circle, letter)
- Roll-number detection

### Part 11: Admin UI for OCR Configuration
- Settings tab: thresholds, engine toggles, model overrides, review sample rate
- Per-org ocr_config JSONB
- Hot-reload without restart

### Part 12: Verification and Close-Out
- All layers meeting thresholds
- Full pipeline run on 80 samples
- Browser E2E with real CVs and certificates
- CI green, tag quest-06

## Rules
- Rule 24: OCR layer isolation — no sibling imports
- Rule 25: OCR accuracy thresholds are contractual
- Rule 26: OCR sample corpus is mandatory (80+ samples)
- Rule 27: No OCR downgrade under any circumstance

## Verification
- [ ] Sample corpus has 80+ samples with ground truth
- [ ] Every layer meets its Rule 25 threshold
- [ ] No layer imports a sibling
- [ ] All 6 candidate tables populated by parser
- [ ] PDFs rasterize correctly
- [ ] OMR accuracy improved
- [ ] Admin UI works
- [ ] CI green on close-out commit
- [ ] Tag quest-06 correct
- [ ] Committed per Rule 19
- [ ] Pushed per Rule 20
