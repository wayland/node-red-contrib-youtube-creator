'use strict';

const matrix = require('./transition-matrix.json');
const stages = require('./stages');

const LIVE_GOALS = new Set(['livestarting', 'live', 'complete']);

function applySkipTestingOverride(currentStage, goal, entry, skipTesting) {
    if (!skipTesting || !entry || entry.data?.action !== 'transition') {
        return entry;
    }

    const current = stages.normalizeStage(currentStage);
    const goalNorm = stages.normalizeStage(goal);
    const next = stages.normalizeStage(entry.data.next_state);

    if (current === 'ready' && LIVE_GOALS.has(goalNorm) && next === 'teststarting') {
        return {
            ...entry,
            data: {
                ...entry.data,
                next_state: 'livestarting'
            }
        };
    }

    return entry;
}

function lookupTransition(currentStage, goal, skipTesting) {
    const currentKey = stages.toMatrixKey(currentStage);
    const goalNorm = stages.normalizeStage(goal);
    const goalKey = `towards_${goalNorm}`;
    const row = matrix.transitions[currentKey];

    if (!row || !row[goalKey]) {
        return {
            action: 'error',
            message: `No transition defined for ${currentStage} -> ${goalNorm}`
        };
    }

    const entry = applySkipTestingOverride(currentStage, goalNorm, row[goalKey], skipTesting);
    const data = entry.data || {};

    if (data.action === 'notice') {
        return {
            action: 'notice',
            message: data.message || 'Stream is ahead of schedule'
        };
    }

    if (data.action === 'log') {
        return {
            action: 'error',
            message: data.message || "Can't handle the stream status"
        };
    }

    if (data.action === 'transition') {
        return {
            action: 'transition',
            next_stage: data.next_state,
            goal_stage: data.goal_state
        };
    }

    return {
        action: 'error',
        message: `Unknown matrix action for ${currentStage} -> ${goalNorm}`
    };
}

module.exports = {
    lookupTransition,
    applySkipTestingOverride
};
