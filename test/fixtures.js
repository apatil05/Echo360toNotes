// Shared fixtures for the unit tests and scripts/e2e.mjs.

// Includes a caption that is only a number and one that starts with "NOTE" — both used
// to be silently dropped by the caption parser.
export const LECTURE_SENTENCES = [
  'Good morning everyone. Today we are covering merge sort, a divide and conquer sorting algorithm.',
  'You split the array in half, recursively sort each half, then merge the two sorted halves back together.',
  'Think of it like splitting a deck of cards in half until every pile has one card. That is my favorite analogy.',
  'This is very important and it will be on the exam: merge sort always runs in n log n time in the best, average and worst case.',
  'NOTE for the exam: merge sort is not in place. It needs order n extra space, and students lose points every year saying it uses constant space.',
  'Merge sort is stable. John von Neumann invented merge sort in the year',
  '1945',
  'Quicksort is usually faster in practice but has an n squared worst case. Next lecture we will cover heaps.',
];

export const LECTURE_TEXT = LECTURE_SENTENCES.join(' ');

export const SLIDE_LINES = [
  'CS201 Lecture 12: Merge Sort',
  'Slide 1: Divide and Conquer',
  '- Divide: split the array into two halves',
  '- Conquer: recursively sort each half',
  '- Combine: merge two sorted halves',
  'Slide 2: Complexity',
  '- Time: Theta(n log n) in all cases',
  '- Space: O(n) auxiliary, not in-place',
  '- Stable: yes',
];

function timestamp(seconds, sep) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}${sep}000`;
}

function captions(cues, sep, header) {
  return header + cues
    .map((text, i) => `${i + 1}\n${timestamp(i * 5, sep)} --> ${timestamp(i * 5 + 5, sep)}\n${text}\n`)
    .join('\n');
}

export const toVtt = (cues = LECTURE_SENTENCES) => captions(cues, '.', 'WEBVTT\n\n');
export const toSrt = (cues = LECTURE_SENTENCES) => captions(cues, ',', '');

/** Builds a minimal valid single-page PDF with one line of text per entry. */
export function makePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const content = ['BT', '/F1 12 Tf', '16 TL', '50 780 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
