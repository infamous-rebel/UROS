#!/usr/bin/env ts-node
/**
 * OCR Sample Corpus Generator — Quest 06 Part 1
 *
 * Renders SVG document templates to PNG at multiple quality levels,
 * producing 80+ samples with ground truth JSON and a manifest.
 *
 * Usage: npm run generate:corpus
 */

import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

// ─── Paths ───────────────────────────────────────────────────────────────────

const CORPUS = path.resolve(__dirname, '..');
const DOCS = path.join(CORPUS, 'documents');

// ─── Font Configuration ──────────────────────────────────────────────────────
// All fonts are bundled in tests/ocr-corpus/templates/fonts/ (OFL-licensed).
// The run.sh wrapper sets FONTCONFIG_PATH so sharp/libvips finds them on both
// macOS and Ubuntu CI. No system fonts are used.

// Bangla font families (5 families, 7 files — >= 5 required by Rule 26)
const BANGLA_FONTS = ['NotoSansBengali', 'HindSiliguri', 'SolaimanLipi', 'Kalpurush', 'Mukti'];
// English font families (3 families — >= 3 required)
const ENGLISH_FONTS = ['Inter', 'Roboto', 'Open Sans'];

// ─── Quality Variants ────────────────────────────────────────────────────────

type SharpInstance = ReturnType<typeof sharp>;

interface QualityVariant {
  name: string;
  dpi: number;
  transform?: (img: SharpInstance) => Promise<Buffer>;
}

const QUALITY_VARIANTS: QualityVariant[] = [
  { name: '300dpi_clean', dpi: 300 },
  { name: '300dpi_skewed', dpi: 300, transform: applySkew },
  { name: '150dpi_clean', dpi: 150 },
  { name: '300dpi_blurred', dpi: 300, transform: applyBlur },
  { name: '300dpi_lowcontrast', dpi: 300, transform: applyLowContrast },
];

async function applySkew(img: SharpInstance): Promise<Buffer> {
  // Rotate by 2 degrees with white background
  return img.rotate(2, { background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
}

async function applyBlur(img: SharpInstance): Promise<Buffer> {
  return img.blur(1.5).png().toBuffer();
}

async function applyLowContrast(img: SharpInstance): Promise<Buffer> {
  // Reduce contrast by linearly interpolating toward gray
  const raw = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const gray = 128;
  const factor = 0.3; // 30% contrast stretch
  for (let i = 0; i < data.length; i += info.channels) {
    data[i] = Math.round(gray + (data[i] - gray) * factor);
    data[i + 1] = Math.round(gray + (data[i + 1] - gray) * factor);
    data[i + 2] = Math.round(gray + (data[i + 2] - gray) * factor);
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

// ─── SVG Helpers ─────────────────────────────────────────────────────────────

function svgWrap(width: number, height: number, content: string, bg = '#ffffff'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="${bg}"/>
${content}
</svg>`;
}

function textEl(x: number, y: number, text: string, opts: {
  font?: string; size?: number; weight?: string; fill?: string; anchor?: string;
}): string {
  const { font = 'NotoSansBengali', size = 24, weight = 'regular', fill = '#000000', anchor = 'start' } = opts;
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(text)}</text>`;
}

function rectEl(x: number, y: number, w: number, h: number, opts: {
  fill?: string; stroke?: string; strokeWidth?: number; rx?: number;
}): string {
  const { fill = 'none', stroke = '#000000', strokeWidth = 2, rx = 0 } = opts;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" rx="${rx}"/>`;
}

function lineEl(x1: number, y1: number, x2: number, y2: number, stroke = '#000000', strokeWidth = 1): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function circleEl(cx: number, cy: number, r: number, opts: { fill?: string; stroke?: string; strokeWidth?: number }): string {
  const { fill = 'none', stroke = '#000000', strokeWidth = 1 } = opts;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Sample Data ─────────────────────────────────────────────────────────────

interface SampleData {
  candidate_id: string;
  document_type: string;
  script: 'bangla' | 'english' | 'mixed';
  font_index: number;
  [key: string]: any;
}

const SSC_DATA: SampleData[] = [
  {
    candidate_id: 'corpus-ssc-001', document_type: 'ssc_certificate', script: 'bangla', font_index: 0,
    full_name: 'মোঃ রফিকুল ইসলাম', father_name: 'মোঃ আব্দুল করিম', mother_name: 'মোছাঃ রহিমা বেগম',
    date_of_birth: '1998-05-12', roll_number: '123456', registration: '1612345678',
    institution: 'ঢাকা বোর্ড', passing_year: 2016, division_class: 'First', cgpa: 5.0, subject_major: 'Science',
    district: 'ঢাকা', division: 'ঢাকা',
  },
  {
    candidate_id: 'corpus-ssc-002', document_type: 'ssc_certificate', script: 'bangla', font_index: 1,
    full_name: 'ফাতিমা আক্তার', father_name: 'মোঃ নজরুল ইসলাম', mother_name: 'সালেহা বেগম',
    date_of_birth: '1999-03-22', roll_number: '234567', registration: '1712345679',
    institution: 'চট্টগ্রাম বোর্ড', passing_year: 2017, division_class: 'First', cgpa: 4.78, subject_major: 'Science',
    district: 'চট্টগ্রাম', division: 'চট্টগ্রাম',
  },
];

const HSC_DATA: SampleData[] = [
  {
    candidate_id: 'corpus-hsc-001', document_type: 'hsc_certificate', script: 'bangla', font_index: 0,
    full_name: 'মোঃ রফিকুল ইসলাম', father_name: 'মোঃ আব্দুল করিম', mother_name: 'মোছাঃ রহিমা বেগম',
    date_of_birth: '1998-05-12', roll_number: '345678', registration: '1812345678',
    institution: 'ঢাকা বোর্ড', passing_year: 2018, division_class: 'First', cgpa: 5.0, subject_major: 'Science',
    district: 'ঢাকা', division: 'ঢাকা', college: 'ঢাকা কলেজ',
  },
  {
    candidate_id: 'corpus-hsc-002', document_type: 'hsc_certificate', script: 'bangla', font_index: 1,
    full_name: 'ফাতিমা আক্তার', father_name: 'মোঃ নজরুল ইসলাম', mother_name: 'সালেহা বেগম',
    date_of_birth: '1999-03-22', roll_number: '456789', registration: '1912345679',
    institution: 'চট্টগ্রাম বোর্ড', passing_year: 2019, division_class: 'First', cgpa: 4.89, subject_major: 'Science',
    district: 'চট্টগ্রাম', division: 'চট্টগ্রাম', college: 'চট্টগ্রাম কলেজ',
  },
];

const NID_DATA: SampleData[] = [
  {
    candidate_id: 'corpus-nid-001', document_type: 'nid_card', script: 'bangla', font_index: 0, side: 'front',
    full_name: 'মোঃ আব্দুল করিম', father_name: '', mother_name: '',
    date_of_birth: '1975-08-20', nid_number: '1234567890', issue_date: '2020-01-15', expiry_date: '2030-01-14',
    address: 'গ্রাম: মিরপুর, থানা: মিরপুর, জেলা: ঢাকা', blood_group: 'B+',
    place_of_birth: 'ঢাকা', nationality: 'বাংলাদেশী',
  },
  {
    candidate_id: 'corpus-nid-002', document_type: 'nid_card', script: 'bangla', font_index: 1, side: 'front',
    full_name: 'সালেহা বেগম', father_name: '', mother_name: '',
    date_of_birth: '1980-11-05', nid_number: '9876543210', issue_date: '2021-03-10', expiry_date: '2031-03-09',
    address: 'গ্রাম: হালিশহর, থানা: হালিশহর, জেলা: চট্টগ্রাম', blood_group: 'A+',
    place_of_birth: 'চট্টগ্রাম', nationalty: 'বাংলাদেশী',
  },
];

const TRANSCRIPT_DATA: SampleData[] = [
  {
    candidate_id: 'corpus-transcript-001', document_type: 'university_transcript', script: 'english', font_index: 0,
    full_name: 'Md. Rafiqul Islam', father_name: 'Md. Abdul Karim', mother_name: 'Rahima Begum',
    date_of_birth: '1998-05-12', university: 'University of Dhaka', degree: 'B.Sc. in Computer Science',
    passing_year: 2022, cgpa: 3.75, total_credits: 120,
    courses: [
      { code: 'CSE101', title: 'Introduction to Programming', credit: 3, grade: 'A' },
      { code: 'CSE201', title: 'Data Structures', credit: 3, grade: 'A-' },
      { code: 'MATH101', title: 'Calculus I', credit: 3, grade: 'B+' },
      { code: 'ENG101', title: 'English Composition', credit: 2, grade: 'A' },
      { code: 'CSE301', title: 'Algorithms', credit: 3, grade: 'A' },
    ],
  },
  {
    candidate_id: 'corpus-transcript-002', document_type: 'university_transcript', script: 'english', font_index: 1,
    full_name: 'Fatima Aktar', father_name: 'Md. Nazrul Islam', mother_name: 'Saleha Begum',
    date_of_birth: '1999-03-22', university: 'BUET', degree: 'B.Sc. in EEE',
    passing_year: 2023, cgpa: 3.85, total_credits: 130,
    courses: [
      { code: 'EEE101', title: 'Electrical Circuits', credit: 3, grade: 'A' },
      { code: 'EEE201', title: 'Electronics', credit: 3, grade: 'A-' },
      { code: 'MATH201', title: 'Linear Algebra', credit: 3, grade: 'A' },
      { code: 'PHY101', title: 'Physics I', credit: 3, grade: 'B+' },
      { code: 'EEE301', title: 'Power Systems', credit: 3, grade: 'A' },
    ],
  },
];

const BANK_FORM_DATA: SampleData[] = [
  {
    candidate_id: 'corpus-bank-001', document_type: 'bank_application', script: 'english', font_index: 0,
    full_name: 'Md. Rafiqul Islam', father_name: 'Md. Abdul Karim', mother_name: 'Rahima Begum',
    date_of_birth: '1998-05-12', national_id: '1234567890', phone: '01712345678', email: 'rafiq@example.com',
    permanent_address: 'Village: Mirpur, PS: Mirpur, Dist: Dhaka', present_address: 'House 12, Road 5, Dhanmondi, Dhaka',
    district: 'Dhaka', division: 'Dhaka', account_type: 'Savings', initial_deposit: '1000',
    nomination_name: 'Rahima Begum', nomination_relation: 'Mother',
    occupation: 'Service', employer_name: 'ABC Company', monthly_income: '45000',
  },
  {
    candidate_id: 'corpus-bank-002', document_type: 'bank_application', script: 'english', font_index: 1,
    full_name: 'Fatima Aktar', father_name: 'Md. Nazrul Islam', mother_name: 'Saleha Begum',
    date_of_birth: '1999-03-22', national_id: '9876543210', phone: '01812345678', email: 'fatima@example.com',
    permanent_address: 'Village: Halishahar, PS: Halishahar, Dist: Chittagong', present_address: 'Flat 5A, Agrabad C/A, Chittagong',
    district: 'Chittagong', division: 'Chittagong', account_type: 'Current', initial_deposit: '5000',
    nomination_name: 'Nazrul Islam', nomination_relation: 'Father',
    occupation: 'Business', employer_name: 'Self-employed', monthly_income: '80000',
  },
];

const MCQ_DATA: SampleData[] = [
  {
    candidate_id: 'corpus-mcq-001', document_type: 'mcq_sheet', script: 'english', font_index: 0,
    roll_number: '123456', exam_name: 'Recruitment Exam 2024', subject: 'General Knowledge',
    total_questions: 30, // Reduced for SVG size; represent first 30 of 100
    answers: generateMcqAnswers(30, 0.85),
  },
  {
    candidate_id: 'corpus-mcq-002', document_type: 'mcq_sheet', script: 'english', font_index: 1,
    roll_number: '234567', exam_name: 'Recruitment Exam 2024', subject: 'Mathematics',
    total_questions: 30,
    answers: generateMcqAnswers(30, 0.78),
  },
];

const HANDWRITTEN_DATA: SampleData[] = [
  {
    candidate_id: 'corpus-hand-001', document_type: 'handwritten_form', script: 'bangla', font_index: 0,
    full_name: 'মোঃ রফিকুল ইসলাম', father_name: 'মোঃ আব্দুল করিম', mother_name: 'মোছাঃ রহিমা বেগম',
    date_of_birth: '1998-05-12', gender: 'Male', national_id: '1234567890',
    phone: '01712345678', email: 'rafiq@example.com',
    permanent_address: 'গ্রাম: মিরপুর, থানা: মিরপুর, জেলা: ঢাকা',
    present_address: 'বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা',
    district: 'ঢাকা', division: 'ঢাকা',
    education: 'এসএসসি ২০১৬, এইচএসসি ২০১৮, বিএসসি ২০২২',
    experience: '২ বছর অফিস সহকারী',
  },
  {
    candidate_id: 'corpus-hand-002', document_type: 'handwritten_form', script: 'bangla', font_index: 1,
    full_name: 'ফাতিমা আক্তার', father_name: 'মোঃ নজরুল ইসলাম', mother_name: 'সালেহা বেগম',
    date_of_birth: '1999-03-22', gender: 'Female', national_id: '9876543210',
    phone: '01812345678', email: 'fatima@example.com',
    permanent_address: 'গ্রাম: হালিশহর, থানা: হালিশহর, জেলা: চট্টগ্রাম',
    present_address: 'ফ্ল্যাট ৫এ, আগ্রাবাদ, চট্টগ্রাম',
    district: 'চট্টগ্রাম', division: 'চট্টগ্রাম',
    education: 'এসএসসি ২০১৭, এইচএসসি ২০১৯, বিএসসি ২০২৩',
    experience: '১ বছর ইন্টার্ন',
  },
];

const MIXED_DATA: SampleData[] = [
  {
    candidate_id: 'corpus-mixed-001', document_type: 'mixed_bangla_english', script: 'mixed', font_index: 0,
    full_name: 'মোঃ রফিকুল ইসলাম (Md. Rafiqul Islam)', father_name: 'মোঃ আব্দুল করিম',
    date_of_birth: '1998-05-12', phone: '01712345678', email: 'rafiq@example.com',
    institution: 'University of Dhaka / ঢাকা বিশ্ববিদ্যালয়', degree: 'B.Sc. in CSE',
    passing_year: 2022, cgpa: 3.75,
    skills: 'Python, JavaScript, ঢাকা, চট্টগ্রাম',
    language: 'Bangla (Native), English (Fluent)',
  },
  {
    candidate_id: 'corpus-mixed-002', document_type: 'mixed_bangla_english', script: 'mixed', font_index: 1,
    full_name: 'ফাতিমা আক্তার (Fatima Aktar)', father_name: 'মোঃ নজরুল ইসলাম',
    date_of_birth: '1999-03-22', phone: '01812345678', email: 'fatima@example.com',
    institution: 'BUET / বুয়েট', degree: 'B.Sc. in EEE',
    passing_year: 2023, cgpa: 3.85,
    skills: 'MATLAB, C++, রাজশাহী, সিলেট',
    language: 'Bangla (Native), English (Fluent)',
  },
];

function generateMcqAnswers(count: number, fillRate: number): string[] {
  const options = ['A', 'B', 'C', 'D', 'E'];
  const answers: string[] = [];
  // Use deterministic seed based on count
  let seed = count * 7 + 13;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if ((seed % 100) / 100 < fillRate) {
      answers.push(options[seed % 5]);
    } else {
      answers.push(''); // Unfilled
    }
  }
  return answers;
}

// ─── SVG Template Generators ─────────────────────────────────────────────────

const W = 794; // A4 width at ~96 DPI
const H = 1123; // A4 height at ~96 DPI

function generateSSCSvg(data: SampleData): string {
  const font = BANGLA_FONTS[data.font_index % BANGLA_FONTS.length];
  const elements: string[] = [];

  // Border
  elements.push(rectEl(30, 30, W - 60, H - 60, { stroke: '#1a237e', strokeWidth: 3 }));
  elements.push(rectEl(40, 40, W - 80, H - 80, { stroke: '#1a237e', strokeWidth: 1 }));

  // Header
  elements.push(textEl(W / 2, 100, 'গণপ্রজাতন্ত্রী বাংলাদেশ সরকার', { font, size: 28, weight: 'bold', anchor: 'middle' }));
  elements.push(textEl(W / 2, 135, 'মাধ্যমিক ও উচ্চ মাধ্যমিক শিক্ষা বোর্ড', { font, size: 22, anchor: 'middle' }));
  elements.push(textEl(W / 2, 170, data.institution as string, { font, size: 24, weight: 'bold', anchor: 'middle' }));

  // Title
  elements.push(textEl(W / 2, 220, 'মাধ্যমিক বিদ্যালয় সার্টিফিকেট', { font, size: 26, weight: 'bold', anchor: 'middle' }));
  elements.push(textEl(W / 2, 250, 'Secondary School Certificate (SSC)', { font: 'Inter', size: 18, anchor: 'middle' }));

  // Divider
  elements.push(lineEl(80, 270, W - 80, 270, '#1a237e', 2));

  // Fields
  const fields = [
    ['নাম / Name', data.full_name as string],
    ['পিতার নাম / Father\'s Name', data.father_name as string],
    ['মাতার নাম / Mother\'s Name', data.mother_name as string],
    ['জন্ম তারিখ / Date of Birth', data.date_of_birth as string],
    ['রোল নম্বর / Roll Number', data.roll_number as string],
    ['নিবন্ধন নং / Registration No', data.registration as string],
    ['বিভাগ / Division', data.division_class as string],
    ['CGPA', String(data.cgpa)],
    ['বিষয় / Subject', data.subject_major as string],
    ['জেলা / District', data.district as string],
    ['বিভাগ / Division', data.division as string],
  ];

  let y = 310;
  for (const [label, value] of fields) {
    elements.push(textEl(80, y, label, { font, size: 16, weight: 'bold' }));
    elements.push(textEl(350, y, value, { font, size: 18 }));
    elements.push(lineEl(340, y + 5, W - 80, y + 5, '#cccccc', 1));
    y += 45;
  }

  // Passing year
  elements.push(textEl(80, y + 20, `পাশের বছর / Passing Year: ${data.passing_year}`, { font, size: 20, weight: 'bold' }));

  // Footer
  elements.push(lineEl(80, H - 150, W - 80, H - 150, '#000000', 1));
  elements.push(textEl(W - 150, H - 100, 'পরীক্ষা নিয়ন্ত্রক', { font, size: 16, anchor: 'middle' }));
  elements.push(textEl(W - 150, H - 75, 'Controller of Examinations', { font: 'Inter', size: 12, anchor: 'middle' }));

  // Seal circle
  elements.push(circleEl(150, H - 120, 40, { stroke: '#1a237e', strokeWidth: 2 }));
  elements.push(textEl(150, H - 115, 'সিল', { font, size: 14, anchor: 'middle' }));

  return svgWrap(W, H, elements.join('\n'));
}

function generateHSCSvg(data: SampleData): string {
  const font = BANGLA_FONTS[data.font_index % BANGLA_FONTS.length];
  const elements: string[] = [];

  // Border
  elements.push(rectEl(30, 30, W - 60, H - 60, { stroke: '#b71c1c', strokeWidth: 3 }));
  elements.push(rectEl(40, 40, W - 80, H - 80, { stroke: '#b71c1c', strokeWidth: 1 }));

  // Header
  elements.push(textEl(W / 2, 100, 'গণপ্রজাতন্ত্রী বাংলাদেশ সরকার', { font, size: 28, weight: 'bold', anchor: 'middle' }));
  elements.push(textEl(W / 2, 135, 'মাধ্যমিক ও উচ্চ মাধ্যমিক শিক্ষা বোর্ড', { font, size: 22, anchor: 'middle' }));
  elements.push(textEl(W / 2, 170, data.institution as string, { font, size: 24, weight: 'bold', anchor: 'middle' }));

  // Title
  elements.push(textEl(W / 2, 220, 'উচ্চ মাধ্যমিক সার্টিফিকেট', { font, size: 26, weight: 'bold', anchor: 'middle' }));
  elements.push(textEl(W / 2, 250, 'Higher Secondary Certificate (HSC)', { font: 'Inter', size: 18, anchor: 'middle' }));

  elements.push(lineEl(80, 270, W - 80, 270, '#b71c1c', 2));

  // Fields
  const fields = [
    ['নাম / Name', data.full_name as string],
    ['পিতার নাম / Father\'s Name', data.father_name as string],
    ['মাতার নাম / Mother\'s Name', data.mother_name as string],
    ['জন্ম তারিখ / Date of Birth', data.date_of_birth as string],
    ['রোল নম্বর / Roll Number', data.roll_number as string],
    ['নিবন্ধন নং / Registration No', data.registration as string],
    ['কলেজ / College', data.college as string],
    ['বিভাগ / Division', data.division_class as string],
    ['CGPA', String(data.cgpa)],
    ['বিষয় / Subject', data.subject_major as string],
    ['জেলা / District', data.district as string],
  ];

  let y = 310;
  for (const [label, value] of fields) {
    elements.push(textEl(80, y, label, { font, size: 16, weight: 'bold' }));
    elements.push(textEl(350, y, value, { font, size: 18 }));
    elements.push(lineEl(340, y + 5, W - 80, y + 5, '#cccccc', 1));
    y += 42;
  }

  elements.push(textEl(80, y + 20, `পাশের বছর / Passing Year: ${data.passing_year}`, { font, size: 20, weight: 'bold' }));

  // Footer
  elements.push(lineEl(80, H - 150, W - 80, H - 150, '#000000', 1));
  elements.push(textEl(W - 150, H - 100, 'পরীক্ষা নিয়ন্ত্রক', { font, size: 16, anchor: 'middle' }));
  elements.push(circleEl(150, H - 120, 40, { stroke: '#b71c1c', strokeWidth: 2 }));

  return svgWrap(W, H, elements.join('\n'));
}

function generateNIDSvg(data: SampleData): string {
  const font = BANGLA_FONTS[data.font_index % BANGLA_FONTS.length];
  const elements: string[] = [];

  // NID card dimensions (landscape, smaller than A4)
  const cardW = 700;
  const cardH = 440;
  const offsetX = (W - cardW) / 2;
  const offsetY = (H - cardH) / 2;

  // Card border
  elements.push(rectEl(offsetX, offsetY, cardW, cardH, { stroke: '#00695c', strokeWidth: 3, rx: 10 }));

  // Header bar
  elements.push(rectEl(offsetX, offsetY, cardW, 60, { fill: '#00695c', stroke: 'none' }));
  elements.push(textEl(offsetX + cardW / 2, offsetY + 25, 'জাতীয় পরিচয়পত্র', { font, size: 22, weight: 'bold', fill: '#ffffff', anchor: 'middle' }));
  elements.push(textEl(offsetX + cardW / 2, offsetY + 48, 'National Identity Card', { font: 'Inter', size: 14, fill: '#ffffff', anchor: 'middle' }));

  // Photo placeholder
  elements.push(rectEl(offsetX + 20, offsetY + 80, 140, 170, { stroke: '#999999', strokeWidth: 1 }));
  elements.push(textEl(offsetX + 90, offsetY + 175, 'ছবি', { font, size: 16, anchor: 'middle' }));

  // Fields
  const fields = [
    ['নাম', data.full_name as string],
    ['পিতা/স্বামী', data.father_name || 'N/A'],
    ['জন্ম তারিখ', data.date_of_birth as string],
    ['জাতীয়তা', data.nationality || 'বাংলাদেশী'],
    ['রক্তের গ্রুপ', data.blood_group as string],
    ['NID নম্বর', data.nid_number as string],
  ];

  let y = offsetY + 105;
  for (const [label, value] of fields) {
    elements.push(textEl(offsetX + 180, y, label + ':', { font, size: 13, weight: 'bold' }));
    elements.push(textEl(offsetX + 320, y, value, { font, size: 15 }));
    y += 30;
  }

  // Address
  elements.push(textEl(offsetX + 180, y + 15, 'ঠিকানা:', { font, size: 13, weight: 'bold' }));
  elements.push(textEl(offsetX + 180, y + 38, data.address as string, { font, size: 14 }));

  // Issue/Expiry
  elements.push(textEl(offsetX + 20, offsetY + cardH - 50, `Issue: ${data.issue_date}`, { font: 'Inter', size: 12 }));
  elements.push(textEl(offsetX + 20, offsetY + cardH - 30, `Expiry: ${data.expiry_date}`, { font: 'Inter', size: 12 }));

  // Signature area
  elements.push(lineEl(offsetX + cardW - 200, offsetY + cardH - 60, offsetX + cardW - 30, offsetY + cardH - 60, '#000000', 1));
  elements.push(textEl(offsetX + cardW - 115, offsetY + cardH - 40, 'Signature', { font: 'Inter', size: 12, anchor: 'middle' }));

  return svgWrap(W, H, elements.join('\n'));
}

function generateTranscriptSvg(data: SampleData): string {
  const font = data.script === 'english' ? ENGLISH_FONTS[data.font_index % ENGLISH_FONTS.length] : BANGLA_FONTS[data.font_index % BANGLA_FONTS.length];
  const elements: string[] = [];

  // Header
  elements.push(textEl(W / 2, 60, data.university as string, { font, size: 28, weight: 'bold', anchor: 'middle' }));
  elements.push(textEl(W / 2, 90, 'Office of the Registrar', { font, size: 18, anchor: 'middle' }));
  elements.push(textEl(W / 2, 120, 'Academic Transcript', { font, size: 22, weight: 'bold', anchor: 'middle' }));
  elements.push(lineEl(60, 140, W - 60, 140, '#000000', 2));

  // Student info
  const info = [
    [`Student Name: ${data.full_name}`, `Father's Name: ${data.father_name}`],
    [`Date of Birth: ${data.date_of_birth}`, `Degree: ${data.degree}`],
    [`Passing Year: ${data.passing_year}`, `CGPA: ${data.cgpa} / 4.00`],
  ];

  let y = 175;
  for (const [left, right] of info) {
    elements.push(textEl(60, y, left, { font, size: 16 }));
    elements.push(textEl(W / 2 + 20, y, right, { font, size: 16 }));
    y += 30;
  }

  // Course table
  y += 20;
  const tableX = 60;
  const tableW = W - 120;
  const colWidths = [80, 280, 60, 60];
  const headers = ['Code', 'Course Title', 'Credit', 'Grade'];

  // Table header
  elements.push(rectEl(tableX, y, tableW, 35, { fill: '#e8eaf6', stroke: '#000000', strokeWidth: 1 }));
  let cx = tableX;
  for (let i = 0; i < headers.length; i++) {
    elements.push(textEl(cx + colWidths[i] / 2, y + 23, headers[i], { font, size: 14, weight: 'bold', anchor: 'middle' }));
    cx += colWidths[i];
  }

  // Table rows
  y += 35;
  const courses = data.courses as Array<{ code: string; title: string; credit: number; grade: string }>;
  for (const course of courses) {
    elements.push(rectEl(tableX, y, tableW, 30, { stroke: '#cccccc', strokeWidth: 1 }));
    cx = tableX;
    const vals = [course.code, course.title, String(course.credit), course.grade];
    for (let i = 0; i < vals.length; i++) {
      elements.push(textEl(cx + colWidths[i] / 2, y + 20, vals[i], { font, size: 13, anchor: 'middle' }));
      cx += colWidths[i];
    }
    y += 30;
  }

  // Total
  elements.push(textEl(60, y + 30, `Total Credits: ${data.total_credits}`, { font, size: 16, weight: 'bold' }));
  elements.push(textEl(60, y + 55, `Cumulative CGPA: ${data.cgpa} / 4.00`, { font, size: 18, weight: 'bold' }));

  // Footer
  elements.push(lineEl(60, H - 120, W - 60, H - 120, '#000000', 1));
  elements.push(textEl(W - 200, H - 80, 'Registrar', { font, size: 16, anchor: 'middle' }));

  return svgWrap(W, H, elements.join('\n'));
}

function generateBankFormSvg(data: SampleData): string {
  const font = ENGLISH_FONTS[data.font_index % ENGLISH_FONTS.length];
  const elements: string[] = [];

  // Header
  elements.push(textEl(W / 2, 50, 'BANK APPLICATION FORM', { font, size: 24, weight: 'bold', anchor: 'middle' }));
  elements.push(textEl(W / 2, 75, 'Account Opening — Personal', { font, size: 16, anchor: 'middle' }));
  elements.push(lineEl(60, 90, W - 60, 90, '#000000', 2));

  // Form fields in labeled rows
  const fields: Array<[string, string]> = [
    ['Full Name', data.full_name as string],
    ['Father\'s Name', data.father_name as string],
    ['Mother\'s Name', data.mother_name as string],
    ['Date of Birth', data.date_of_birth as string],
    ['National ID No', data.national_id as string],
    ['Phone', data.phone as string],
    ['Email', data.email as string],
    ['Permanent Address', data.permanent_address as string],
    ['Present Address', data.present_address as string],
    ['District', data.district as string],
    ['Division', data.division as string],
    ['Account Type', data.account_type as string],
    ['Initial Deposit (BDT)', data.initial_deposit as string],
    ['Nominee Name', data.nomination_name as string],
    ['Nominee Relation', data.nomination_relation as string],
    ['Occupation', data.occupation as string],
    ['Employer', data.employer_name as string],
    ['Monthly Income (BDT)', data.monthly_income as string],
  ];

  let y = 120;
  for (const [label, value] of fields) {
    // Label background
    elements.push(rectEl(60, y - 18, 200, 28, { fill: '#f5f5f5', stroke: '#999999', strokeWidth: 1 }));
    elements.push(textEl(70, y, label, { font, size: 13, weight: 'bold' }));
    // Value field
    elements.push(rectEl(260, y - 18, W - 320, 28, { fill: '#ffffff', stroke: '#999999', strokeWidth: 1 }));
    elements.push(textEl(270, y, value, { font, size: 14 }));
    y += 38;
  }

  // Signature boxes
  y += 30;
  elements.push(textEl(80, y, 'Applicant Signature', { font, size: 12 }));
  elements.push(rectEl(60, y + 5, 200, 60, { stroke: '#000000', strokeWidth: 1 }));
  elements.push(textEl(W - 260, y, 'Bank Officer Signature', { font, size: 12 }));
  elements.push(rectEl(W - 280, y + 5, 200, 60, { stroke: '#000000', strokeWidth: 1 }));

  // Date
  elements.push(textEl(W / 2, y + 90, `Date: _______________`, { font, size: 14, anchor: 'middle' }));

  return svgWrap(W, H, elements.join('\n'));
}

function generateMCQSvg(data: SampleData): string {
  const font = ENGLISH_FONTS[data.font_index % ENGLISH_FONTS.length];
  const elements: string[] = [];
  const answers = data.answers as string[];

  // Header
  elements.push(textEl(W / 2, 50, data.exam_name as string, { font, size: 22, weight: 'bold', anchor: 'middle' }));
  elements.push(textEl(W / 2, 75, `Subject: ${data.subject}`, { font, size: 16, anchor: 'middle' }));
  elements.push(lineEl(60, 90, W - 60, 90, '#000000', 2));

  // Roll number bubbles
  elements.push(textEl(60, 120, 'ROLL NUMBER:', { font, size: 14, weight: 'bold' }));
  const rollDigits = (data.roll_number as string).split('');
  let rx = 200;
  for (const digit of rollDigits) {
    for (let d = 0; d <= 9; d++) {
      const filled = String(d) === digit;
      elements.push(circleEl(rx + d * 22, 115, 8, {
        fill: filled ? '#000000' : 'none',
        stroke: '#000000',
        strokeWidth: 1,
      }));
    }
    rx += 240;
    if (rx > W - 100) break;
  }

  // Answer grid
  const options = ['A', 'B', 'C', 'D', 'E'];
  const startY = 160;
  const rowH = 28;
  const bubbleR = 9;
  const startX = 120;
  const gapX = 50;

  // Column headers
  elements.push(textEl(60, startY, 'Q.No', { font, size: 12, weight: 'bold' }));
  for (let o = 0; o < options.length; o++) {
    elements.push(textEl(startX + o * gapX, startY, options[o], { font, size: 12, weight: 'bold', anchor: 'middle' }));
  }

  // Question rows
  for (let q = 0; q < answers.length; q++) {
    const y = startY + (q + 1) * rowH;
    const qNum = String(q + 1).padStart(2, '0');
    elements.push(textEl(60, y, qNum, { font, size: 12 }));

    for (let o = 0; o < options.length; o++) {
      const filled = answers[q] === options[o];
      elements.push(circleEl(startX + o * gapX, y - 5, bubbleR, {
        fill: filled ? '#000000' : 'none',
        stroke: '#333333',
        strokeWidth: 1,
      }));
      if (filled) {
        elements.push(textEl(startX + o * gapX, y - 1, options[o], { font, size: 10, fill: '#ffffff', anchor: 'middle' }));
      }
    }
  }

  // Footer instruction
  const footerY = startY + (answers.length + 2) * rowH;
  elements.push(textEl(60, footerY, 'Instructions: Fill the bubble completely with a black ballpoint pen.', { font, size: 12 }));

  return svgWrap(W, H, elements.join('\n'));
}

function generateHandwrittenFormSvg(data: SampleData): string {
  // For handwritten forms, we use a cursive-style rendering
  // Since we can't truly simulate handwriting, we use the Bangla fonts with slight variation
  const font = BANGLA_FONTS[data.font_index % BANGLA_FONTS.length];
  const elements: string[] = [];

  // Header
  elements.push(textEl(W / 2, 60, 'আবেদনপত্র', { font, size: 28, weight: 'bold', anchor: 'middle' }));
  elements.push(textEl(W / 2, 90, 'Application Form', { font: 'Inter', size: 18, anchor: 'middle' }));
  elements.push(lineEl(60, 110, W - 60, 110, '#000000', 2));

  // Form fields with underlines (to simulate fill-in-the-blank)
  const fields: Array<[string, string]> = [
    ['নাম / Name', data.full_name as string],
    ['পিতার নাম / Father\'s Name', data.father_name as string],
    ['মাতার নাম / Mother\'s Name', data.mother_name as string],
    ['জন্ম তারিখ / Date of Birth', data.date_of_birth as string],
    ['লিঙ্গ / Gender', data.gender as string],
    ['জাতীয় পরিচয়পত্র নং / NID', data.national_id as string],
    ['ফোন / Phone', data.phone as string],
    ['ইমেইল / Email', data.email as string],
    ['স্থায়ী ঠিকানা / Permanent Address', data.permanent_address as string],
    ['বর্তমান ঠিকানা / Present Address', data.present_address as string],
    ['জেলা / District', data.district as string],
    ['বিভাগ / Division', data.division as string],
    ['শিক্ষাগত যোগ্যতা / Education', data.education as string],
    ['অভিজ্ঞতা / Experience', data.experience as string],
  ];

  let y = 150;
  for (const [label, value] of fields) {
    elements.push(textEl(60, y, label, { font, size: 14, weight: 'bold' }));
    // Underline for value
    elements.push(lineEl(60, y + 30, W - 60, y + 30, '#999999', 1));
    // Value (simulating handwriting with slightly different style)
    elements.push(textEl(60, y + 25, value, { font, size: 18 }));
    y += 55;
  }

  // Signature
  elements.push(textEl(W - 250, H - 120, 'আবেদনকারীর স্বাক্ষর', { font, size: 14 }));
  elements.push(lineEl(W - 250, H - 80, W - 60, H - 80, '#000000', 1));

  return svgWrap(W, H, elements.join('\n'));
}

function generateMixedSvg(data: SampleData): string {
  const bnFont = BANGLA_FONTS[data.font_index % BANGLA_FONTS.length];
  const enFont = ENGLISH_FONTS[data.font_index % ENGLISH_FONTS.length];
  const elements: string[] = [];

  // Header (mixed)
  elements.push(textEl(W / 2, 60, 'জীবনবৃত্তান্ত / Curriculum Vitae', { font: bnFont, size: 24, weight: 'bold', anchor: 'middle' }));
  elements.push(lineEl(60, 80, W - 60, 80, '#1a237e', 2));

  // Sections with mixed language
  const sections: Array<{ labelBn: string; labelEn: string; value: string }> = [
    { labelBn: 'নাম', labelEn: 'Name', value: data.full_name as string },
    { labelBn: 'পিতার নাম', labelEn: 'Father', value: data.father_name as string },
    { labelBn: 'জন্ম তারিখ', labelEn: 'DOB', value: data.date_of_birth as string },
    { labelBn: 'ফোন', labelEn: 'Phone', value: data.phone as string },
    { labelBn: 'ইমেইল', labelEn: 'Email', value: data.email as string },
    { labelBn: 'প্রাতিষ্ঠানিক নাম', labelEn: 'Institution', value: data.institution as string },
    { labelBn: 'ডিগ্রি', labelEn: 'Degree', value: data.degree as string },
    { labelBn: 'পাশের বছর', labelEn: 'Passing Year', value: String(data.passing_year) },
    { labelBn: 'সিজিপিএ', labelEn: 'CGPA', value: String(data.cgpa) },
    { labelBn: 'দক্ষতা', labelEn: 'Skills', value: data.skills as string },
    { labelBn: 'ভাষা', labelEn: 'Language', value: data.language as string },
  ];

  let y = 120;
  for (const s of sections) {
    // Bilingual label
    elements.push(textEl(60, y, `${s.labelBn} / ${s.labelEn}:`, { font: bnFont, size: 14, weight: 'bold' }));
    // Value (may contain mixed script)
    const hasBangla = /[\u0980-\u09FF]/.test(s.value);
    elements.push(textEl(300, y, s.value, { font: hasBangla ? bnFont : enFont, size: 16 }));
    elements.push(lineEl(290, y + 5, W - 60, y + 5, '#cccccc', 1));
    y += 45;
  }

  // Footer
  elements.push(lineEl(60, H - 100, W - 60, H - 100, '#000000', 1));
  elements.push(textEl(W / 2, H - 60, 'I hereby declare that all information is correct.', { font: enFont, size: 12, anchor: 'middle' }));
  elements.push(textEl(W / 2, H - 40, 'আমি ঘোষণা করছি যে সকল তথ্য সঠিক।', { font: bnFont, size: 12, anchor: 'middle' }));

  return svgWrap(W, H, elements.join('\n'));
}

// ─── SVG-to-Document-Type Mapper ─────────────────────────────────────────────

const DOC_TYPE_CONFIG: Array<{
  type: string;
  folder: string;
  data: SampleData[];
  generator: (data: SampleData) => string;
  count: number;
}> = [
  { type: 'ssc_certificate', folder: 'ssc-certificates', data: SSC_DATA, generator: generateSSCSvg, count: 10 },
  { type: 'hsc_certificate', folder: 'hsc-certificates', data: HSC_DATA, generator: generateHSCSvg, count: 10 },
  { type: 'nid_card', folder: 'nid-cards', data: NID_DATA, generator: generateNIDSvg, count: 10 },
  { type: 'university_transcript', folder: 'transcripts', data: TRANSCRIPT_DATA, generator: generateTranscriptSvg, count: 10 },
  { type: 'bank_application', folder: 'bank-forms', data: BANK_FORM_DATA, generator: generateBankFormSvg, count: 10 },
  { type: 'mcq_sheet', folder: 'mcq-sheets', data: MCQ_DATA, generator: generateMCQSvg, count: 10 },
  { type: 'handwritten_form', folder: 'handwritten-forms', data: HANDWRITTEN_DATA, generator: generateHandwrittenFormSvg, count: 10 },
  { type: 'mixed_bangla_english', folder: 'mixed-bangla-english', data: MIXED_DATA, generator: generateMixedSvg, count: 10 },
];

// ─── Ground Truth Builder ────────────────────────────────────────────────────

function buildGroundTruth(data: SampleData, quality: string, sampleIndex: number): Record<string, any> {
  const gt: Record<string, any> = {
    candidate_id: data.candidate_id,
    document_type: data.document_type,
    script: data.script,
    quality,
    source_template: `generator/${data.document_type}`,
    sample_index: sampleIndex,
    expected: {} as Record<string, any>,
  };

  // Copy all data fields except metadata
  const skip = ['candidate_id', 'document_type', 'script', 'font_index', 'side'];
  for (const [k, v] of Object.entries(data)) {
    if (!skip.includes(k)) {
      gt.expected[k] = v;
    }
  }

  return gt;
}

// ─── Main Generator ──────────────────────────────────────────────────────────

interface ManifestEntry {
  sample_id: string;
  document_type: string;
  script: string;
  quality: string;
  font_family: string;
  png_path: string;
  ground_truth_path: string;
  width: number;
  height: number;
  dpi: number;
}

async function main() {
  console.log('=== OCR Corpus Generator ===');
  console.log('Output directory:', DOCS);

  const manifest: ManifestEntry[] = [];
  let totalSamples = 0;

  for (const config of DOC_TYPE_CONFIG) {
    console.log(`\nGenerating ${config.type} (${config.count} samples)...`);
    const outDir = path.join(DOCS, config.folder);
    fs.mkdirSync(outDir, { recursive: true });

    for (let i = 0; i < config.count; i++) {
      // Cycle through base data and quality variants
      const baseData = config.data[i % config.data.length];
      // Vary font across samples
      const dataWithFont: SampleData = {
        ...baseData,
        candidate_id: `${baseData.candidate_id}-${String(i + 1).padStart(3, '0')}`,
        font_index: i % BANGLA_FONTS.length,
      };

      // Each sample gets one quality variant (distributes 10 samples across 5 qualities = 2 per quality)
      const qualityIdx = i % QUALITY_VARIANTS.length;
      const quality = QUALITY_VARIANTS[qualityIdx];

      // Generate SVG
      const svgContent = config.generator(dataWithFont);

      // Calculate dimensions for target DPI
      const scale = quality.dpi / 96; // SVG is at ~96 DPI base
      const targetW = Math.round(W * scale);
      const targetH = Math.round(H * scale);

      // Render SVG to PNG
      const img = sharp(Buffer.from(svgContent)).resize(targetW, targetH);

      let pngBuffer: Buffer;
      if (quality.transform) {
        // Apply quality degradation
        pngBuffer = await quality.transform(img);
      } else {
        pngBuffer = await img.png().toBuffer();
      }

      // Write PNG
      const sampleId = `sample-${String(i + 1).padStart(3, '0')}`;
      const pngName = `${sampleId}.png`;
      const pngPath = path.join(outDir, pngName);
      fs.writeFileSync(pngPath, pngBuffer);

      // Write ground truth JSON
      const gt = buildGroundTruth(dataWithFont, quality.name, i);
      const gtName = `${sampleId}.json`;
      const gtPath = path.join(outDir, gtName);
      fs.writeFileSync(gtPath, JSON.stringify(gt, null, 2));

      // Get actual image dimensions
      const meta = await sharp(pngBuffer).metadata();

      // Add to manifest — record actual font used based on script
      const font = (dataWithFont.script === 'english')
        ? ENGLISH_FONTS[dataWithFont.font_index % ENGLISH_FONTS.length]
        : BANGLA_FONTS[dataWithFont.font_index % BANGLA_FONTS.length];
      manifest.push({
        sample_id: `${config.type}-${sampleId}`,
        document_type: config.type,
        script: dataWithFont.script,
        quality: quality.name,
        font_family: font,
        png_path: path.relative(CORPUS, pngPath),
        ground_truth_path: path.relative(CORPUS, gtPath),
        width: meta.width || targetW,
        height: meta.height || targetH,
        dpi: quality.dpi,
      });

      totalSamples++;
      process.stdout.write(`  ${sampleId} [${quality.name}] ${pngBuffer.length} bytes\n`);
    }
  }

  // Write manifest
  const manifestData = {
    version: '1.0.0',
    total_samples: totalSamples,
    document_types: DOC_TYPE_CONFIG.map(c => ({
      type: c.type,
      folder: c.folder,
      count: c.count,
    })),
    quality_variants: QUALITY_VARIANTS.map(v => ({ name: v.name, dpi: v.dpi })),
    fonts: {
      bangla: BANGLA_FONTS,
      english: ENGLISH_FONTS,
    },
    samples: manifest,
  };

  fs.writeFileSync(path.join(CORPUS, 'manifest.json'), JSON.stringify(manifestData, null, 2));
  console.log(`\nManifest written: ${totalSamples} samples`);

  // Write thresholds
  const thresholds = {
    version: '1.0.0',
    defaults: {
      'layer-00-quality': { threshold: 0.95, metric: 'agreement_with_human_labels', corpus_size: 200 },
      'layer-01-preprocess': { threshold: 0.90, metric: 'usability_by_layer_2', corpus_size: 80 },
      'layer-02-layout': { threshold: 0.85, metric: 'region_detection_f1', corpus_size: 80 },
      'layer-02b-table': { threshold: 0.80, metric: 'cell_level_accuracy', corpus_size: 80 },
      'layer-03-recognition': {
        thresholds: [
          { script: 'printed_bangla', threshold: 0.85, metric: 'character_accuracy' },
          { script: 'printed_english', threshold: 0.92, metric: 'character_accuracy' },
          { script: 'handwritten_digits', threshold: 0.70, metric: 'character_accuracy' },
        ],
      },
      'layer-03b-ensemble': { threshold: 0.05, metric: 'relative_improvement_over_baseline' },
      'layer-04-extraction': { threshold: 0.90, metric: 'field_level_accuracy', corpus_size: 80 },
      'layer-04b-spelling': { threshold: 0.30, metric: 'relative_cer_reduction', corpus_size: 80 },
      'layer-05-validation': { threshold: 1.00, metric: 'contradiction_detection_rate', corpus_size: 20 },
      'layer-05b-forgery': {
        thresholds: [
          { metric: 'precision_on_tampered', threshold: 0.80 },
          { metric: 'specificity_on_authentic', threshold: 0.95 },
        ],
      },
      'layer-06-confidence': { threshold: 0.90, metric: 'agreement_with_human_rating', corpus_size: 100 },
      'layer-07-routing': { threshold: 0.95, metric: 'correct_routing_decisions', corpus_size: 80 },
    },
  };

  fs.writeFileSync(path.join(CORPUS, 'thresholds.json'), JSON.stringify(thresholds, null, 2));
  console.log('Thresholds written');

  console.log('\n=== Generation Complete ===');
  console.log(`Total PNG samples: ${totalSamples}`);
  console.log(`Total ground truth files: ${totalSamples}`);
}

main().catch(err => {
  console.error('Generator failed:', err);
  process.exit(1);
});
