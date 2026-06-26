// lib/efficacy-bridge-select.mjs — pure helpers for the efficacy arm-B measurement:
// (1) select only commits where the bridge CAN bind (lesson identifier ∈ edit region),
// (2) verify the bridge actually fired in an arm-B run (marker present in hook output).
import { extractIdents } from './lesson-idents.mjs';

export function lessonBindsToRegion(lessonText, regionText) {
  const region = String(regionText || '');
  if (!region) return false;
  return extractIdents(lessonText).some((id) => region.includes(id));
}

export const BRIDGE_MARKER = '→ this edit must:';
export function bridgeFired(hookOutput) {
  return String(hookOutput || '').includes(BRIDGE_MARKER);
}
