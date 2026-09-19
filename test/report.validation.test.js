import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SCREENSHOT_BYTES, reportSchema, screenshotSchema } from '../src/lib/report-validation.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4X8AAAAASUVORK5CYII=', 'base64');
const screenshot = (type = 'image/png', bytes = png) => ({ name: 'report.png', type, dataUrl: `data:${type};base64,${bytes.toString('base64')}` });

test('accepts a PNG screenshot and plain report', () => {
  assert.equal(screenshotSchema.safeParse(screenshot()).success, true);
  assert.equal(reportSchema.safeParse({ message: 'The assessment page would not open.' }).success, true);
});

test('rejects disguised content, mismatched MIME types, and unsafe filenames', () => {
  assert.equal(screenshotSchema.safeParse(screenshot('image/png', Buffer.from('<script>alert(1)</script>'))).success, false);
  assert.equal(screenshotSchema.safeParse(screenshot('image/jpeg')).success, false);
  assert.equal(screenshotSchema.safeParse({ ...screenshot(), dataUrl: `data:image/jpeg;base64,${png.toString('base64')}` }).success, false);
  for (const name of ['../report.png', 'a\\b.png', 'file\n.png']) assert.equal(screenshotSchema.safeParse({ ...screenshot(), name }).success, false);
});

test('enforces the same 4 MB decoded limit as the browser', () => {
  const bytes = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1);
  png.copy(bytes);
  assert.equal(screenshotSchema.safeParse(screenshot('image/png', bytes)).success, false);
});

test('strips query tokens and fragments before emailing a report URL', () => {
  const result = reportSchema.parse({ message: 'Something went wrong here', pageUrl: 'https://www.optimusco.de/invite?token=private#secret' });
  assert.equal(result.pageUrl, 'https://www.optimusco.de/invite');
  for (const pageUrl of ['not a url', 'javascript:alert(1)', 'https://user:password@example.com/path']) assert.equal(reportSchema.safeParse({ message: 'Something went wrong here', pageUrl }).success, false);
});

test('rejects short or oversized report text', () => {
  for (const message of ['', 'short', 'x'.repeat(5001)]) assert.equal(reportSchema.safeParse({ message }).success, false);
});
