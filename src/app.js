import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import challengeRoutes from './routes/challenge.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import waitlistRoutes from './routes/waitlist.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(compression());
  app.use(express.json({ limit: '128kb' }));
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
    }),
  );

  if (!env.isProd) app.use(morgan('dev'));

  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'optimus-code', env: env.nodeEnv }));

  app.use('/api/auth', authRoutes);
  app.use('/api/challenge', challengeRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/waitlist', waitlistRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
