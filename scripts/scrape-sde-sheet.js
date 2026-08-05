/**
 * Rebuilds data/problems.json from the live Striver SDE Sheet.
 *
 * The page is a Next.js app; the full problem list ships inside the RSC flight
 * payload as a sequence of `self.__next_f.push([1, "<chunk>"])` calls, so we
 * reassemble the chunks and pull the `sections` array out of the result.
 *
 *   node scripts/scrape-sde-sheet.js
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://takeuforward.org/dsa/strivers-sde-sheet-top-coding-interview-problems';

const TOPIC_MAP = {
  Arrays: 'Arrays',
  'Arrays Part-II': 'Arrays',
  'Arrays Part-III': 'Arrays',
  'Arrays Part-IV': 'Arrays',
  'Linked List': 'Linked List',
  'Linked List Part-II': 'Linked List',
  'Linked List and Arrays': 'Linked List',
  'Greedy Algorithm': 'Greedy',
  Recursion: 'Recursion & Backtracking',
  'Recursion and Backtracking': 'Recursion & Backtracking',
  'Binary Search': 'Binary Search',
  Heaps: 'Heaps',
  'Stack and Queue': 'Stack & Queue',
  'Stack and Queue Part-II': 'Stack & Queue',
  String: 'Strings',
  'String Part-II': 'Strings',
  'Binary Tree': 'Binary Tree',
  'Binary Tree part-II': 'Binary Tree',
  'Binary Tree part-III': 'Binary Tree',
  'Binary Trees[Miscellaneous]': 'Binary Tree',
  'Binary Search Tree': 'Binary Search Tree',
  'Binary Search Tree Part-II': 'Binary Search Tree',
  Graph: 'Graphs',
  'Graph Part-II': 'Graphs',
  'Dynamic Programming': 'Dynamic Programming',
  'Dynamic Programming Part-II': 'Dynamic Programming',
  Trie: 'Trie',
};

/** Reads a JSON string literal starting at `start` and returns [value, endIndex]. */
function readJsonString(text, start) {
  let i = start + 1;
  let out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      const escapes = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
      if (next === 'u') {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        out += escapes[next] ?? next;
        i += 2;
      }
      continue;
    }
    if (ch === '"') return [out, i + 1];
    out += ch;
    i += 1;
  }
  throw new Error('unterminated string in flight payload');
}

function reassembleFlightPayload(html) {
  const marker = 'self.__next_f.push([1,';
  const parts = [];
  let index = html.indexOf(marker);
  while (index !== -1) {
    let cursor = index + marker.length;
    while (html[cursor] === ' ') cursor += 1;
    if (html[cursor] === '"') {
      const [chunk] = readJsonString(html, cursor);
      parts.push(chunk);
    }
    index = html.indexOf(marker, index + marker.length);
  }
  return parts.join('');
}

/** Extracts the balanced JSON array that starts at `start`. */
function sliceArray(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced sections array');
}

const clean = (value) => (!value || value === '$undefined' ? null : String(value).trim());

const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const response = await fetch(SOURCE_URL, {
  headers: { 'user-agent': 'optimus-code-scraper/1.0 (+https://github.com/ayan-mn18/Optimus-Code)' },
});
if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);

const flight = reassembleFlightPayload(await response.text());
const key = '"sections":';
const keyIndex = flight.indexOf(key);
if (keyIndex === -1) throw new Error('sections payload not found — the page structure changed');

const sections = JSON.parse(sliceArray(flight, flight.indexOf('[', keyIndex + key.length)));

const seen = new Set();
const problems = [];

for (const section of sections) {
  const topic = TOPIC_MAP[section.category_name];
  if (!topic) throw new Error(`unmapped category: ${section.category_name}`);

  for (const raw of section.problems) {
    const title = clean(raw.problem_name);
    const slug = slugify(title);
    if (seen.has(slug)) continue;
    seen.add(slug);

    problems.push({
      slug,
      title,
      topic,
      difficulty: clean(raw.difficulty) ?? 'Medium',
      leetcode_url: clean(raw.leetcode),
      youtube_url: clean(raw.youtube),
      article_url: clean(raw.article),
      source: 'Striver SDE Sheet',
      order_index: problems.length + 1,
    });
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, '..', 'data', 'problems.json');
await fs.writeFile(dest, `${JSON.stringify(problems, null, 2)}\n`);

const byTopic = problems.reduce((acc, p) => ({ ...acc, [p.topic]: (acc[p.topic] ?? 0) + 1 }), {});
console.log(`scraped ${problems.length} problems across ${Object.keys(byTopic).length} topics`);
console.table(byTopic);
console.log(`wrote ${path.relative(process.cwd(), dest)}`);
