/**
 * Formats the disclosed-gap header every translated schema is printed
 * with — the automated equivalent of the hand-translated
 * `thirdparty/*.authz` files' own header comments (see e.g.
 * `openfga-github.authz`'s "Disclosed simplification" paragraph, or
 * `thirdparty/README.md`'s own "Known, disclosed expressiveness gaps"
 * section). Those files' prose was hand-written once and could drift out
 * of sync with what a translator actually does; a note built here is
 * produced from the same real narrowing/drop `translate.ts` applies while
 * building the `IrSchema`, in the same call — there is nothing for it to
 * drift out of sync with.
 *
 * Deliberately plain, greppable text — no markdown, no wrapping-width
 * cleverness — every line is prefixed `// ` so the whole block is a valid
 * DSL comment (`parser.ts`'s own `//`-starts-a-line-comment rule) sitting
 * directly above the translated namespaces it describes.
 */
export interface TranslationNote {
  /** A short, stable tag for what kind of note this is — e.g. `'condition-dropped'`, `'nested-userset-narrowed'` — grep-able, not shown to a reader. */
  readonly kind: string;
  /** The human-readable sentence describing what happened and why. */
  readonly detail: string;
}

export function formatDisclosureHeader(opts: {
  readonly title: string;
  readonly sourceUrl?: string;
  readonly notes: readonly TranslationNote[];
}): string {
  const lines: string[] = [`// ${opts.title}`];
  if (opts.sourceUrl !== undefined) {
    lines.push(`// Source: ${opts.sourceUrl}`);
  }
  if (opts.notes.length === 0) {
    lines.push(
      '//',
      '// No disclosed gaps — every construct in the source model translated directly.',
    );
  } else {
    lines.push('//', '// Disclosed, automated translation notes:');
    for (const note of opts.notes) {
      lines.push(`// - ${note.detail}`);
    }
  }
  return lines.join('\n') + '\n\n';
}
