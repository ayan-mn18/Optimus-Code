import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMilestone, reachedMilestone } from '../src/services/milestone.service.js';

test('reachedMilestone advances only at 50-solve boundaries', () => {
  assert.equal(reachedMilestone(0), 0);
  assert.equal(reachedMilestone(49), 0);
  assert.equal(reachedMilestone(50), 50);
  assert.equal(reachedMilestone(99), 50);
  assert.equal(reachedMilestone(100), 100);
});

test('analyzeMilestone freezes behavior at the milestone solve', () => {
  const solves = Array.from({ length: 51 }, (_, index) => ({
    solved_on: `2026-01-${String((index % 10) + 1).padStart(2, '0')}`,
    is_bonus: index < 10,
    time_spent_min: index < 5 ? 20 : null,
    problem: {
      topic: index < 20 ? 'Arrays' : index < 35 ? 'Graphs' : 'Dynamic Programming',
      difficulty: index < 20 ? 'Easy' : index < 40 ? 'Medium' : 'Hard',
    },
  }));

  const recap = analyzeMilestone({
    user: { name: 'Test Solver', avatar_seed: 'test' },
    milestone: 50,
    solves,
    streak: { current: 7, longest: 12, greenDays: 20 },
    dailyTarget: 5,
  });

  assert.equal(recap.milestone, 50);
  assert.equal(recap.nextMilestone, 100);
  assert.deepEqual(recap.topTopics[0], { topic: 'Arrays', count: 20 });
  assert.deepEqual(recap.difficulty, { Easy: 20, Medium: 20, Hard: 10 });
  assert.equal(recap.totals.activeDays, 10);
  assert.equal(recap.totals.bonus, 10);
  assert.equal(recap.totals.trackedMinutes, 100);
  assert.equal(recap.recommendation.daily, 5);
  assert.equal(recap.recommendation.projectedDays, 10);
  assert.equal(recap.headline, 'Arrays became your home ground.');
});
