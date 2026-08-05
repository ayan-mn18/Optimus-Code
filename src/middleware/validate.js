import { ApiError } from '../lib/errors.js';

/** Validates `req[source]` against a zod schema and replaces it with the parsed value. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    return next(ApiError.badRequest('Validation failed', details));
  }

  if (source === 'query') {
    req.validatedQuery = result.data;
  } else {
    req[source] = result.data;
  }
  next();
};
