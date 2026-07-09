// ============================================================================
// Minimal X12 EDI tokenizer.
//
// Separators are read from the ISA envelope when present (element separator
// at offset 3; ISA is fixed-width 106 chars, so the component separator sits
// at offset 104 and the segment terminator at 105). Files without an ISA fall
// back to the conventional * ~ : set. Newlines after segment terminators are
// tolerated.
// ============================================================================

export interface Segment {
  /** segment ID, e.g. 'CLP' */
  id: string;
  /** elements AFTER the ID: elements[0] is CLP01 */
  elements: string[];
}

export interface X12Document {
  segments: Segment[];
  componentSeparator: string;
}

export function parseX12(raw: string): X12Document {
  const text = raw.replace(/^﻿/, '');
  let elementSep = '*';
  let segmentSep = '~';
  let componentSep = ':';

  if (text.startsWith('ISA') && text.length >= 106) {
    elementSep = text[3];
    componentSep = text[104];
    segmentSep = text[105];
  }

  const segments: Segment[] = [];
  for (const chunk of text.split(segmentSep)) {
    const s = chunk.replace(/[\r\n]+/g, '').trim();
    if (!s) continue;
    const parts = s.split(elementSep);
    segments.push({ id: parts[0], elements: parts.slice(1) });
  }
  return { segments, componentSeparator: componentSep };
}

/** element accessor: el(seg, 1) -> CLP01, '' when absent */
export function el(seg: Segment | undefined, n: number): string {
  return seg?.elements[n - 1]?.trim() ?? '';
}

/** split a composite element ('HC:99213:25') on the component separator */
export function components(value: string, componentSep: string): string[] {
  return value ? value.split(componentSep) : [];
}

/** 'D8' CCYYMMDD -> ISO date; returns null on anything unparseable */
export function x12Date(value: string): string | null {
  const v = value.trim();
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (/^\d{6}$/.test(v)) return `20${v.slice(0, 2)}-${v.slice(2, 4)}-${v.slice(4, 6)}`;
  return null;
}

export function x12Amount(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
