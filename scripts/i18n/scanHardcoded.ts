import ts from 'typescript';

/**
 * Finds hard-coded English user-visible text in TSX source: JSX text nodes, string-literal values of
 * user-visible JSX props (label, title, placeholder, aria-label …) and `toast(...)` texts.
 * Text that goes through `t(...)` / `translateLiteral(...)` (or `tl(...)`) is fine. Used by the
 * i18n coverage test and for finding strings to translate.
 */
export interface Hardcoded {
  line: number;
  kind: 'text' | 'prop' | 'toast' | 'expr';
  text: string;
}

const TEXT_PROPS = new Set([
  'label',
  'title',
  'placeholder',
  'aria-label',
  'alt',
  'description',
  'hint',
  'tooltip',
  'emptyText',
  'empty',
  'heading',
  'caption',
  'subtitle',
  'help',
  'message',
  'confirmLabel',
  'cancelLabel',
]);

/** Letters in a Latin word of at least 2 characters (so "·", "×", "…", "%" and "1" are ignored). */
const WORD = /[A-Za-z]{2,}/;

export function scanHardcoded(source: string, fileName = 'x.tsx'): Hardcoded[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Hardcoded[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (n: ts.Node, kind: Hardcoded['kind'], text: string) => {
    if (WORD.test(text))
      out.push({ line: lineOf(n), kind, text: text.replace(/\s+/g, ' ').trim() });
  };
  const isTranslateCall = (n: ts.Node): boolean =>
    (ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      ['t', 'tl', 'translateLiteral'].includes(n.expression.text)) ||
    (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && n.tag.text === 'tt');

  const visit = (n: ts.Node): void => {
    if (isTranslateCall(n)) return;
    if (ts.isJsxText(n)) {
      add(n, 'text', n.getText(sf));
    } else if (ts.isJsxAttribute(n) && TEXT_PROPS.has(n.name.getText(sf)) && n.initializer) {
      const init = n.initializer;
      if (ts.isStringLiteral(init)) add(init, 'prop', init.text);
      else if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression;
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) add(e, 'prop', e.text);
        else if (ts.isTemplateExpression(e))
          add(e, 'prop', e.head.text + e.templateSpans.map((s) => s.literal.text).join(' '));
      }
    } else if (ts.isJsxExpression(n) && n.expression && n.parent && ts.isJsxElement(n.parent)) {
      const e = n.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) add(e, 'expr', e.text);
    } else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'toast'
    ) {
      n.arguments.slice(1).forEach((a) => {
        if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) add(a, 'toast', a.text);
        else if (ts.isTemplateExpression(a)) add(a, 'toast', a.head.text);
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
