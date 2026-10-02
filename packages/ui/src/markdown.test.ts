import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, markdownPreview } from './markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

/** Shaped like a real Social Scout answer. */
const BRIEFING = `I found **seven TikTok accounts** worth buying a promo from now.

## TikTok

| # | Handle | Followers | Verdict and reason |
|---|---|---:|---|
| 1 | [@plain.t3a](https://www.tiktok.com/@plain.t3a) | 146K | **Buy now.** Football edits on Relax |
| – | @guerchom_edit_son | 166K | *Rising* 3.7× \\| steady |

## Saved
- **Network:** the 7 "buy now" accounts were added as leads.
- **Drive:** the full table is in \`Funk edit promo shortlist.csv\`.
  - one more detail
1. first
2. second`;

describe('Markdown', () => {
  it('renders headings, tables, lists, bold, italic, code and links', () => {
    const out = html(BRIEFING);
    expect(out).toContain('<strong>seven TikTok accounts</strong>');
    expect(out).toContain('<h3 class="lc-md-h1">TikTok</h3>');
    expect(out.match(/<tr>/g)).toHaveLength(3);
    expect(out).toContain('<th style="text-align:right">Followers</th>');
    expect(out).toContain('<a href="https://www.tiktok.com/@plain.t3a" target="_blank" rel="noopener noreferrer">@plain.t3a</a>');
    // Underscores inside handles are not italics; an escaped pipe stays in its cell.
    expect(out).toContain('@guerchom_edit_son');
    expect(out).toContain('<em>Rising</em> 3.7× | steady');
    expect(out).toContain('<li><strong>Network:</strong> the 7 &quot;buy now&quot; accounts were added as leads.</li>');
    expect(out).toContain('<code class="lc-md-code">Funk edit promo shortlist.csv</code>');
    expect(out).toMatch(/<ul class="lc-md-list"><li>one more detail<\/li><\/ul>/);
    expect(out).toContain('<ol class="lc-md-list"><li>first</li><li>second</li></ol>');
  });

  it('never emits raw HTML or unsafe links', () => {
    const out = html('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](/agents/runs) https://example.com/a.');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('[click](javascript:alert(1))');
    expect(out).toContain('<a href="/agents/runs">ok</a>');
    expect(out).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>.');
  });

  it('keeps line breaks inside paragraphs and fenced code as written', () => {
    expect(html('line one\nline two')).toContain('line one<br/>line two');
    expect(html('```\n| not | a table |\n**x**\n```')).toContain('<pre class="lc-md-pre"><code>| not | a table |\n**x**</code></pre>');
  });
});

describe('markdownPreview', () => {
  it('turns Markdown into one plain line for lists', () => {
    expect(markdownPreview(BRIEFING, 400)).toMatch(/^I found seven TikTok accounts worth buying a promo from now\. # · Handle · Followers/);
    expect(markdownPreview('**Bold** and [a link](https://x.y) and `code`')).toBe('Bold and a link and code');
    expect(markdownPreview('x'.repeat(300), 50)).toHaveLength(50);
  });
});
