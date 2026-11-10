import assert from 'node:assert/strict';
import { test } from 'node:test';

const { renderChatMarkdown } = await import('./markdown.ts');

test('raw HTML is escaped, never emitted as elements', () => {
  for (const source of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://evil.example"></iframe>', '<a href="javascript:alert(1)">x</a>', '<div onclick="x()">y</div>']) {
    const html = renderChatMarkdown(source);
    assert.doesNotMatch(html, /<(script|img|iframe|div)\b/i, source);
    assert.doesNotMatch(html, /<a href="javascript/i, source);
    assert.match(html, /&lt;/, source);
  }
});

test('javascript:, data:, vbscript: and protocol-relative links are not rendered as anchors', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html;base64,AAAA', 'vbscript:x', '//evil.example/x', 'file:///etc/passwd']) {
    const html = renderChatMarkdown(`[click](${url})`);
    assert.doesNotMatch(html, /<a\b/i, url);
    assert.doesNotMatch(html, /href=/i, url);
  }
});

test('safe links get noopener noreferrer nofollow and a new tab', () => {
  for (const url of ['https://example.com/a?b=1', 'http://example.com', '/pricing']) {
    const html = renderChatMarkdown(`[ok](${url})`);
    assert.match(html, /<a href="[^"]+" rel="noopener noreferrer nofollow" target="_blank">ok<\/a>/, url);
  }
  assert.match(renderChatMarkdown('<https://example.com>'), /rel="noopener noreferrer nofollow"/);
});

test('images never become <img>: a remote image turns into a plain safe link, unsafe ones into text', () => {
  const remote = renderChatMarkdown('![alt](https://evil.example/pixel.png)');
  assert.doesNotMatch(remote, /<img|src=/i);
  assert.match(remote, /<a href="https:\/\/evil\.example\/pixel\.png" rel="noopener noreferrer nofollow" target="_blank">alt<\/a>/);
  for (const url of ['data:image/png;base64,AAAA', 'javascript:alert(1)']) {
    const html = renderChatMarkdown(`![x](${url})`);
    assert.doesNotMatch(html, /<img|<a\b|src=|href=/i, url);
  }
});

test('nothing the renderer emits can trigger a remote load', () => {
  const html = renderChatMarkdown(
    ['![a](https://evil.example/1.png)', '<img src="https://evil.example/2.png">', '<link rel=stylesheet href="https://evil.example/3.css">', '[l](https://example.com)', '```\n<script src=//evil.example/4.js></script>\n```', '`<img src=x>`'].join('\n\n'),
  );
  assert.doesNotMatch(html, /<(img|link|script|iframe|video|audio|source|object|embed|style)\b/i);
});

test('ordinary markdown still renders', () => {
  const html = renderChatMarkdown('# T\n\n**bold** and `code`\n\n- a\n- b\n\nline1\nline2');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>a<\/li>/);
  assert.match(html, /line1<br>\s*line2/);
  assert.equal(renderChatMarkdown(''), '');
});
