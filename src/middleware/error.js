import { env } from '../config/env.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: `No route for ${req.method} ${req.originalUrl}` } });
}

// eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
export function errorHandler(err, _req, res, _next) {
  const status = err.status ?? 500;

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({
    error: {
      message: status >= 500 && env.isProd ? 'Something went wrong on our side' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}
