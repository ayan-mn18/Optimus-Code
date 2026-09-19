import { z } from 'zod';

export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export const screenshotSchema = z.object({
  name: z.string().trim().min(1).max(120).refine((name) => !name.includes('/') && !name.includes('\\') && [...name].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Use a plain screenshot filename'),
  type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dataUrl: z.string().max(Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 64)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/, 'Screenshot must be a base64 PNG, JPEG, or WebP image'),
}).superRefine((image, context) => {
  const comma = image.dataUrl.indexOf(',');
  if (comma < 0) return;
  const base64 = image.dataUrl.slice(comma + 1);
  const bytes = Buffer.from(base64, 'base64');
  const signatureMatches = image.type === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : image.type === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (image.dataUrl.slice(0, comma) !== `data:${image.type};base64`
    || bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')
    || !signatureMatches || bytes.length > MAX_SCREENSHOT_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dataUrl'], message: 'Screenshot content must match its image type and be at most 4 MB' });
  }
});

export const reportSchema = z.object({
  message: z.string().trim().min(10, 'Tell us a little more about the problem').max(5_000),
  steps: z.string().trim().max(2_000).optional(),
  pageUrl: z.string().trim().url().max(500).refine((value) => {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }, 'Page must be an HTTP(S) URL without credentials').transform((value) => {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  }).optional(),
  userAgent: z.string().trim().max(500).optional(),
  screenshot: screenshotSchema.optional(),
});
