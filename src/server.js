import { createApp } from './app.js';
import { env } from './config/env.js';
import { startEmailNotificationWorker } from './services/notification.service.js';
import { startAssessmentWorker } from './services/assessment/worker.js';

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`optimus-code api listening on http://localhost:${env.port} (${env.nodeEnv})`);
});

const stopEmailWorker = startEmailNotificationWorker();
const stopAssessmentWorker = startAssessmentWorker();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopEmailWorker();
    stopAssessmentWorker();
    console.log(`\n${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
