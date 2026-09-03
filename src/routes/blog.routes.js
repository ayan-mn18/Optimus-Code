import { Router } from 'express';
import { z } from 'zod';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createBlog,
  deleteBlog,
  getBlog,
  listBlogs,
  listMyBlogs,
  toggleBlogLike,
  updateBlog,
} from '../services/blog.service.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Block document                                                              */
/* Kept permissive on purpose: the reader ignores block types it cannot render, */
/* so the research pipeline can add a block kind before the UI ships one.       */
/* -------------------------------------------------------------------------- */

const blockSchema = z.object({
  type: z.string().min(1).max(40),
}).passthrough();

const companySchema = z.object({
  name: z.string().trim().min(1).max(60),
  count: z.number().int().nonnegative().optional(),
  roles: z.array(z.string().trim().max(60)).max(10).optional(),
  lastSeen: z.string().trim().max(40).optional(),
  sources: z.array(z.string().url()).max(10).optional(),
});

const refSchema = z.object({
  title: z.string().trim().min(1).max(200),
  url: z.string().url(),
  source: z.string().trim().max(60).optional(),
  kind: z.enum(['problem', 'article', 'discussion', 'video', 'repo', 'other']).default('article'),
  note: z.string().trim().max(300).optional(),
});

const listSchema = z.object({
  kind: z.enum(['DSA', 'LLD', 'HLD', 'General']).optional(),
  topic: z.string().trim().min(1).max(120).optional(),
  company: z.string().trim().min(1).max(60).optional(),
  tag: z.string().trim().min(1).max(60).optional(),
  search: z.string().trim().max(120).optional(),
  problemId: z.string().uuid().optional(),
  sort: z.enum(['recent', 'popular', 'liked']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(12),
});

const createSchema = z.object({
  title: z.string().trim().min(4).max(160),
  slug: z.string().trim().max(120).optional(),
  summary: z.string().trim().max(400).optional(),
  kind: z.enum(['DSA', 'LLD', 'HLD', 'General']).default('LLD'),
  problemId: z.string().uuid().nullable().optional(),
  topic: z.string().trim().max(120).optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).nullable().optional(),
  coverEmoji: z.string().trim().max(8).optional(),
  status: z.enum(['draft', 'published']).default('draft'),
  blocks: z.array(blockSchema).max(400).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  companies: z.array(companySchema).max(40).default([]),
  refs: z.array(refSchema).max(40).default([]),
});

const updateSchema = createSchema.partial();

router.get('/', optionalAuth, validate(listSchema, 'query'), async (req, res, next) => {
  try {
    res.json(await listBlogs(req.user, req.validatedQuery));
  } catch (error) {
    next(error);
  }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    res.json(await listMyBlogs(req.user));
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, validate(createSchema), async (req, res, next) => {
  try {
    res.status(201).json({ blog: await createBlog(req.user, req.body) });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', requireAuth, validate(updateSchema), async (req, res, next) => {
  try {
    res.json({ blog: await updateBlog(req.user, req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    await deleteBlog(req.user, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/:id/like', requireAuth, async (req, res, next) => {
  try {
    res.json(await toggleBlogLike(req.user, req.params.id));
  } catch (error) {
    next(error);
  }
});

// Last: a bare segment would otherwise swallow /mine.
router.get('/:slug', optionalAuth, async (req, res, next) => {
  try {
    res.json(await getBlog(req.user, req.params.slug));
  } catch (error) {
    next(error);
  }
});

export default router;
