import { createApp } from './app.js';
import { env } from './config/env.js';
import { startEmailNotificationWorker } from './services/notification.service.js';

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`optimus-code api listening on http://localhost:${env.port} (${env.nodeEnv})`);
});

const stopEmailWorker = startEmailNotificationWorker();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopEmailWorker();
    console.log(`\n${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
