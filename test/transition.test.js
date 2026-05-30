'use strict';

const assert = require('assert');
const stages = require('../lib/stages');
const { lookupTransition, applySkipTestingOverride } = require('../lib/transition');

describe('stages', function () {
    it('maps YouTube lifeCycleStatus values', function () {
        assert.strictEqual(stages.mapYouTubeStatus('testStarting'), 'teststarting');
        assert.strictEqual(stages.mapYouTubeStatus('liveStarting'), 'livestarting');
        assert.strictEqual(stages.mapYouTubeStatus('revoked'), 'revoked');
    });

    it('compares stages along the canonical path', function () {
        assert.strictEqual(stages.compareStages('ready', 'live', false), -1);
        assert.strictEqual(stages.compareStages('live', 'testing', false), 1);
        assert.strictEqual(stages.compareStages('ready', 'live', true), -1);
    });

    it('validates goals', function () {
        assert.strictEqual(stages.isValidGoal('live'), true);
        assert.strictEqual(stages.isInvalidGoal('revoked'), true);
    });
});

describe('transition matrix', function () {
    it('plans ready -> testing via teststarting', function () {
        const plan = lookupTransition('ready', 'testing', false);
        assert.strictEqual(plan.action, 'transition');
        assert.strictEqual(plan.next_stage, 'teststarting');
        assert.strictEqual(plan.goal_stage, 'testing');
    });

    it('emits notice when goal is behind current stage', function () {
        const plan = lookupTransition('live', 'testing', false);
        assert.strictEqual(plan.action, 'notice');
    });

    it('emits error for revoked state', function () {
        const plan = lookupTransition('revoked', 'live', false);
        assert.strictEqual(plan.action, 'error');
    });

    it('applies skipTesting override from ready toward live', function () {
        const plan = lookupTransition('ready', 'live', true);
        assert.strictEqual(plan.next_stage, 'livestarting');
    });

    it('override helper replaces teststarting with livestarting', function () {
        const entry = {
            data: {
                action: 'transition',
                next_state: 'teststarting',
                goal_state: 'live'
            }
        };
        const updated = applySkipTestingOverride('ready', 'live', entry, true);
        assert.strictEqual(updated.data.next_state, 'livestarting');
    });
});
