/**
 * Witness/fuzz-trial labels (an invariant's own variable names — `s`,
 * `o`, `orgA`, `orgB`, per the mixed-case convention `docs/DECISIONS.md`
 * D-115 deliberately allows for variable names — plus generated `objN`
 * labels) are not automatically valid tuple object/subject ids: the real
 * tuple store enforces the same lowercase `snake_case` `IDENTIFIER_PATTERN`
 * schema names use (`src/store/tuples.ts`'s `validateIdentifiers`).
 * `orgB` fails that check outright. This maps each distinct label to a
 * real, valid, and — within one mapper instance — collision-free id, so
 * self-validation writes tuples the real store will actually accept.
 */
const VALID_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export type LabelToId = (label: string) => string;

/** A fresh mapper per replay/fuzz-trial — labels never leak stability across independent replays, matching how each gets its own fresh scratch store. */
export function createLabelToIdMapper(): LabelToId {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  return (label: string): string => {
    const existing = assigned.get(label);
    if (existing !== undefined) return existing;
    let base = label.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!/^[a-z]/.test(base)) base = `v_${base}`;
    let candidate = base;
    let n = 0;
    while (used.has(candidate) || !VALID_ID_PATTERN.test(candidate)) {
      n += 1;
      candidate = `${base}_${n}`;
    }
    used.add(candidate);
    assigned.set(label, candidate);
    return candidate;
  };
}
