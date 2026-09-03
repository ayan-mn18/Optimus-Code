import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://codewitharyan.com';
const SHEETS = [
  { kind: 'LLD', slug: 'low-level-design', expected: 73 },
  { kind: 'HLD', slug: 'high-level-design', expected: 205 },
];

const clean = (value) => {
  if (value == null) return null;
  const text = String(value)
    .replace(/&amp;/g, '&')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/[\u00a0\s]+/g, ' ')
    .trim();
  return text || null;
};

const difficulty = (value) => {
  const normalized = clean(value) ?? 'Medium';
  return ['Easy', 'Medium', 'Hard'].includes(normalized) ? normalized : 'Medium';
};

const codingEnabled = (kind, topic, subtopic, question) => {
  if (kind !== 'LLD') return false;
  const category = `${topic} ${subtopic}`.toLowerCase();
  const title = String(question.name ?? '').trim().toLowerCase();
  return /interview problem|concurrency/.test(category) || /^design\b/.test(title);
};

async function loadSheet(sheet) {
  const url = `${SOURCE}/api/user/sheet/${sheet.slug}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'optimus-code-catalog/1.0 (+https://github.com/ayan-mn18/Optimus-Code)' },
  });
  if (!response.ok) throw new Error(`fetch failed for ${url}: ${response.status} ${response.statusText}`);

  const payload = await response.json();
  if (!payload?.sheet?.topics?.length) throw new Error(`missing topic data at ${url}`);

  const rows = [];
  for (const topic of payload.sheet.topics) {
    for (const subtopic of topic.subtopics ?? []) {
      for (const question of subtopic.questions ?? []) {
        const sourceSlug = clean(question.slug);
        const title = clean(question.name);
        if (!sourceSlug || !title) continue;

        rows.push({
          slug: `${sourceSlug}-${topic.id}-${subtopic.id}`,
          title,
          kind: sheet.kind,
          topic: clean(topic.name) ?? 'General',
          subtopic: clean(subtopic.name),
          difficulty: difficulty(question.difficulty),
          description: clean(question.description),
          leetcode_url: null,
          youtube_url: clean(question.youtubeLink),
          article_url: clean(question.articleLink),
          practice_url: clean(question.practiceLink),
          source_url: `${SOURCE}/questions/${encodeURIComponent(sourceSlug)}`,
          resource_metadata: {
            sourceId: question.id,
            companyTags: (question.companyTags ?? []).map(clean).filter(Boolean),
            tags: (question.miscTags ?? []).map(clean).filter(Boolean),
          },
          assessment_enabled: true,
          coding_enabled: codingEnabled(sheet.kind, topic.name, subtopic.name, question),
          source: 'Code With Aryan',
          order_index: rows.length + 1,
        });
      }
    }
  }

  if (rows.length !== sheet.expected) {
    throw new Error(`${sheet.kind} source changed: expected ${sheet.expected}, received ${rows.length}`);
  }
  const unique = new Set(rows.map((row) => row.slug));
  if (unique.size !== rows.length) throw new Error(`${sheet.kind} contains duplicate slugs`);
  return rows;
}

const groups = await Promise.all(SHEETS.map(loadSheet));
const problems = groups.flat();
const here = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(here, '..', 'data', 'system-design.json');
await fs.writeFile(destination, `${JSON.stringify(problems, null, 2)}\n`);

for (const sheet of SHEETS) {
  const rows = problems.filter((problem) => problem.kind === sheet.kind);
  console.log(`${sheet.kind}: ${rows.length} items across ${new Set(rows.map((row) => row.topic)).size} topics`);
}
console.log(`wrote ${path.relative(process.cwd(), destination)}`);
