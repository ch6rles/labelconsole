/**
 * A small syntax colourer for the text viewer: comments, strings, numbers,
 * keywords, tags and keys for the languages files in Drive tend to be in.
 * It works line by line, carrying open block comments and multi-line strings
 * across lines, and never needs to be perfect, only helpful.
 */
export type Token = { text: string; type?: 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'tag' | 'attr' | 'key' | 'punct' | 'heading' | 'meta' };
export type Lang = 'js' | 'json' | 'css' | 'python' | 'ruby' | 'shell' | 'sql' | 'yaml' | 'toml' | 'ini' | 'xml' | 'markdown' | 'c' | 'go' | 'rust' | 'php' | 'plain';

const LANG_BY_EXT: Record<string, Lang> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'json', css: 'css', scss: 'css', py: 'python', rb: 'ruby', sh: 'shell', env: 'shell',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  c: 'c', h: 'c', cpp: 'c', cs: 'c', java: 'c', kt: 'c', swift: 'c', go: 'go', rs: 'rust', php: 'php', graphql: 'js',
};

export const langFor = (ext: string): Lang => LANG_BY_EXT[ext] ?? 'plain';

const words = (s: string) => new Set(s.split(' '));
const KEYWORDS: Partial<Record<Lang, Set<string>>> = {
  js: words('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield query mutation fragment'),
  python: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self'),
  ruby: words('alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then unless until when while yield require'),
  shell: words('if then else elif fi for while do done case esac in function return export local readonly echo exit set unset source'),
  sql: words('select from where and or not insert into values update set delete create table alter drop index view join left right inner outer full on group by order having limit offset as distinct union all case when then else end primary key foreign references default null is in like between exists returning with'),
  c: words('auto break case catch char class const continue default delete do double else enum extern final float for fun goto if import include int interface long namespace new override package private protected public return short signed sizeof static struct super switch this throw try typedef union unsigned using val var virtual void volatile while let func guard'),
  go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
  rust: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while'),
  php: words('abstract and as break case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global if implements include instanceof interface isset list namespace new or print private protected public require return static switch throw trait try unset use var while yield'),
  css: words('important media import supports keyframes font-face from to and not only'),
};
const LITERALS = words('true false null undefined None True False nil NaN Infinity');

type State = { block?: 'comment' | 'string'; close?: string };

/** Rules per language: [regex, token type]. Order matters; the first match at a position wins. */
function rules(lang: Lang): Array<[RegExp, Token['type'] | 'word']> {
  const num: [RegExp, Token['type']] = [/^-?(?:0x[\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b/i, 'number'];
  const dq: [RegExp, Token['type']] = [/^"(?:[^"\\]|\\.)*"?/, 'string'];
  const sq: [RegExp, Token['type']] = [/^'(?:[^'\\]|\\.)*'?/, 'string'];
  const word: [RegExp, 'word'] = [/^[A-Za-z_$][\w$-]*/, 'word'];
  switch (lang) {
    case 'json':
      return [[/^"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'], dq, num, [/^(true|false|null)\b/, 'literal'], [/^[{}[\],:]/, 'punct']];
    case 'js':
      return [[/^\/\/.*/, 'comment'], dq, sq, [/^`(?:[^`\\]|\\.)*`?/, 'string'], num, [/^[A-Za-z_$][\w$]*/, 'word']];
    case 'c':
    case 'go':
    case 'rust':
      return [[/^\/\/.*/, 'comment'], [/^#!?\[?\w+/, 'meta'], dq, sq, [/^`[^`]*`?/, 'string'], num, [/^[A-Za-z_$][\w$]*/, 'word']];
    case 'php':
      return [[/^(\/\/|#(?!\[)).*/, 'comment'], [/^\$\w+/, 'attr'], dq, sq, num, [/^[A-Za-z_][\w]*/, 'word']];
    case 'css':
      return [[/^[\w-]+(?=\s*:)/, 'key'], [/^[.#][\w-]+/, 'tag'], [/^@[\w-]+/, 'keyword'], dq, sq, [/^#[\da-f]{3,8}\b/i, 'number'], [/^-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?/, 'number'], word];
    case 'python':
      return [[/^#.*/, 'comment'], [/^@[\w.]+/, 'meta'], dq, sq, num, [/^[A-Za-z_]\w*/, 'word']];
    case 'ruby':
    case 'shell':
      return [[/^#.*/, 'comment'], [/^\$\{?[\w@#?*!-]+\}?/, 'attr'], dq, sq, num, [/^[A-Za-z_][\w-]*/, 'word']];
    case 'sql':
      return [[/^--.*/, 'comment'], sq, dq, num, [/^[A-Za-z_]\w*/, 'word']];
    case 'yaml':
      return [[/^#.*/, 'comment'], [/^(\s*-\s+)?[^\s:#'"][^:#]*?(?=:(\s|$))/, 'key'], dq, sq, num, [/^(true|false|null|yes|no|on|off|~)\b/i, 'literal'], [/^[&*][\w-]+/, 'meta']];
    case 'toml':
    case 'ini':
      return [[/^[#;].*/, 'comment'], [/^\[[^\]]*\]/, 'tag'], [/^[\w.-]+(?=\s*=)/, 'key'], dq, sq, num, [/^(true|false)\b/, 'literal']];
    case 'xml':
      return [[/^<!--.*?(-->|$)/, 'comment'], [/^<\/?[\w:.-]+/, 'tag'], [/^\/?>/, 'tag'], [/^[\w:.-]+(?==)/, 'attr'], dq, sq, [/^&[#\w]+;/, 'meta']];
    case 'markdown':
      return [[/^#{1,6}\s.*/, 'heading'], [/^(\*\*|__)[^*_]+\1/, 'keyword'], [/^`[^`]+`/, 'string'], [/^\[[^\]]*\]\([^)]*\)/, 'attr'], [/^(\s*([-*+]|\d+\.)\s)/, 'punct'], [/^>.*/, 'comment']];
    default:
      return [];
  }
}

const BLOCK: Partial<Record<Lang, Array<{ open: string; close: string; type: 'comment' | 'string' }>>> = {
  js: [{ open: '/*', close: '*/', type: 'comment' }],
  c: [{ open: '/*', close: '*/', type: 'comment' }],
  go: [{ open: '/*', close: '*/', type: 'comment' }],
  rust: [{ open: '/*', close: '*/', type: 'comment' }],
  php: [{ open: '/*', close: '*/', type: 'comment' }],
  css: [{ open: '/*', close: '*/', type: 'comment' }],
  sql: [{ open: '/*', close: '*/', type: 'comment' }],
  python: [
    { open: '"""', close: '"""', type: 'string' },
    { open: "'''", close: "'''", type: 'string' },
  ],
  xml: [{ open: '<!--', close: '-->', type: 'comment' }],
};

/** Tokens for every line of a file. Lines longer than 2,000 characters (minified files) are left plain. */
export function highlightLines(lines: string[], lang: Lang): Token[][] {
  const table = rules(lang);
  const blocks = BLOCK[lang] ?? [];
  const kw = KEYWORDS[lang];
  const caseless = lang === 'sql';
  const state: State = {};
  const out: Token[][] = [];
  for (const line of lines) {
    if (lang === 'plain' || line.length > 2000) {
      out.push([{ text: line }]);
      continue;
    }
    const tokens: Token[] = [];
    let plain = '';
    const push = (text: string, type?: Token['type']) => {
      if (!text) return;
      if (!type) {
        plain += text;
        return;
      }
      if (plain) tokens.push({ text: plain });
      plain = '';
      tokens.push({ text, type });
    };
    let i = 0;
    while (i < line.length) {
      if (state.block) {
        const end = line.indexOf(state.close!, i);
        if (end === -1) {
          push(line.slice(i), state.block);
          i = line.length;
          break;
        }
        push(line.slice(i, end + state.close!.length), state.block);
        i = end + state.close!.length;
        state.block = undefined;
        continue;
      }
      const rest = line.slice(i);
      const opener = blocks.find((b) => rest.startsWith(b.open));
      if (opener) {
        state.block = opener.type;
        state.close = opener.close;
        push(opener.open, opener.type);
        i += opener.open.length;
        continue;
      }
      let matched = false;
      for (const [re, type] of table) {
        const m = re.exec(rest);
        if (!m || !m[0]) continue;
        if (type === 'word') {
          const w = caseless ? m[0].toLowerCase() : m[0];
          push(m[0], kw?.has(w) ? 'keyword' : LITERALS.has(m[0]) ? 'literal' : undefined);
        } else push(m[0], type);
        i += m[0].length;
        matched = true;
        break;
      }
      if (!matched) {
        push(line[i]);
        i++;
      }
    }
    if (plain) tokens.push({ text: plain });
    out.push(tokens);
  }
  return out;
}
