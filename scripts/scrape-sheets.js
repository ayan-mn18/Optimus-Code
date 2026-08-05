/**
 * Rebuilds data/problems.json from the takeuforward sheets.
 *
 * Both sheets are Next.js pages that ship their problem list inside the RSC
 * flight payload as a sequence of `self.__next_f.push([1, "<chunk>"])` calls, so
 * we reassemble the chunks and pull the `sections` array out of the result.
 * The SDE sheet puts problems directly on a section; the A2Z sheet nests them
 * one level deeper under `subcategories`.
 *
 *   node scripts/scrape-sheets.js
 *
 * Problems are deduped on slug across sheets — the SDE sheet is processed first,
 * so a problem in both keeps its SDE entry and its original order.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHEETS = [
  {
    name: 'Striver SDE Sheet',
    url: 'https://takeuforward.org/dsa/strivers-sde-sheet-top-coding-interview-problems',
  },
  {
    name: 'Striver A2Z Sheet',
    url: 'https://takeuforward.org/dsa/strivers-a2z-sheet-learn-dsa-a-to-z',
  },
];

/**
 * Section (or subsection) name → canonical topic. Matched by prefix, so the
 * bracketed suffixes the sheets carry ("Graphs [Concepts & Problems]") don't
 * need to be reproduced exactly.
 */
const TOPIC_RULES = [
  // A2Z's "Learn the basics" section spans several real topics, so its
  // subsections are matched before the section itself.
  ['Know Basic Maths', 'Math'],
  ['Learn Basic Recursion', 'Recursion & Backtracking'],
  ['Learn Basic Hashing', 'Hashing'],
  ['Learn the basics', 'Basics'],

  ['Learn Important Sorting', 'Sorting'],
  ['Solve Problems on Arrays', 'Arrays'],
  ['Arrays', 'Arrays'],
  ['Binary Search Tree', 'Binary Search Tree'],
  ['Binary Search', 'Binary Search'],
  ['Binary Tree', 'Binary Tree'],
  ['Strings', 'Strings'],
  ['String', 'Strings'],
  ['Learn LinkedList', 'Linked List'],
  ['Linked List', 'Linked List'],
  ['Recursion', 'Recursion & Backtracking'],
  ['Bit Manipulation', 'Bit Manipulation'],
  ['Stack and Queue', 'Stack & Queue'],
  ['Sliding Window', 'Sliding Window & Two Pointer'],
  ['Heaps', 'Heaps'],
  ['Greedy', 'Greedy'],
  ['Graph', 'Graphs'],
  ['Dynamic Programming', 'Dynamic Programming'],
  ['Trie', 'Trie'],
];

/** Resolves a topic from the subsection first, falling back to the section. */
function topicFor(sectionName, subsectionName) {
  for (const candidate of [subsectionName, sectionName]) {
    if (!candidate) continue;
    const match = TOPIC_RULES.find(([prefix]) => candidate.startsWith(prefix));
    if (match) return match[1];
  }
  throw new Error(`unmapped section: ${sectionName} / ${subsectionName ?? '—'}`);
}

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

/** The sheets are inconsistent about case ("hard" vs "Hard"). */
function normalizeDifficulty(value) {
  const text = clean(value);
  if (!text) return 'Medium';
  const titled = text[0].toUpperCase() + text.slice(1).toLowerCase();
  return ['Easy', 'Medium', 'Hard'].includes(titled) ? titled : 'Medium';
}

async function fetchSections(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'optimus-code-scraper/1.0 (+https://github.com/ayan-mn18/Optimus-Code)' },
  });
  if (!response.ok) throw new Error(`fetch failed for ${url}: ${response.status} ${response.statusText}`);

  const flight = reassembleFlightPayload(await response.text());
  const key = '"sections":';
  const keyIndex = flight.indexOf(key);
  if (keyIndex === -1) throw new Error(`sections payload not found at ${url} — the page structure changed`);

  return JSON.parse(sliceArray(flight, flight.indexOf('[', keyIndex + key.length)));
}

/** Flattens both section shapes into { sectionName, subsectionName, problem }. */
function* walk(sections) {
  for (const section of sections) {
    const groups = section.subcategories?.length
      ? section.subcategories.map((sub) => [sub.subcategory_name, sub.problems ?? []])
      : [[null, section.problems ?? []]];

    for (const [subsectionName, problems] of groups) {
      for (const problem of problems) {
        yield { sectionName: section.category_name, subsectionName, problem };
      }
    }
  }
}

const seen = new Set();
const problems = [];
const perSheet = {};

for (const sheet of SHEETS) {
  const sections = await fetchSections(sheet.url);
  let added = 0;
  let skipped = 0;

  for (const { sectionName, subsectionName, problem: raw } of walk(sections)) {
    const title = clean(raw.problem_name);
    if (!title) continue;

    const slug = slugify(title);
    if (seen.has(slug)) {
      skipped += 1;
      continue;
    }
    seen.add(slug);
    added += 1;

    problems.push({
      slug,
      title,
      topic: topicFor(sectionName, subsectionName),
      difficulty: normalizeDifficulty(raw.difficulty),
      leetcode_url: clean(raw.leetcode),
      youtube_url: clean(raw.youtube),
      article_url: clean(raw.article),
      source: sheet.name,
      order_index: problems.length + 1,
    });
  }

  perSheet[sheet.name] = { added, deduped: skipped };
  console.log(`${sheet.name}: +${added} new, ${skipped} already present`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, '..', 'data', 'problems.json');
await fs.writeFile(dest, `${JSON.stringify(problems, null, 2)}\n`);

const byTopic = problems.reduce((acc, p) => ({ ...acc, [p.topic]: (acc[p.topic] ?? 0) + 1 }), {});
const byDifficulty = problems.reduce((acc, p) => ({ ...acc, [p.difficulty]: (acc[p.difficulty] ?? 0) + 1 }), {});

console.log(`\n${problems.length} problems across ${Object.keys(byTopic).length} topics`);
console.table(byTopic);
console.log(byDifficulty);
console.log(
  `links — leetcode: ${problems.filter((p) => p.leetcode_url).length}, ` +
    `youtube: ${problems.filter((p) => p.youtube_url).length}`,
);
console.log(`wrote ${path.relative(process.cwd(), dest)}`);
