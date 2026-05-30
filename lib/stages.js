'use strict';

const VALID_GOALS = new Set([
    'not_yet_set',
    'not_exist',
    'created',
    'ready',
    'teststarting',
    'testing',
    'livestarting',
    'live',
    'complete'
]);

const INVALID_GOALS = new Set(['revoked', 'lifecyclestatusunspecified']);

const CANONICAL_SEQUENCE = [
    'not_yet_set',
    'not_exist',
    'created',
    'ready',
    'teststarting',
    'testing',
    'livestarting',
    'live',
    'complete'
];

const CANONICAL_SEQUENCE_SKIP_TESTING = [
    'not_yet_set',
    'not_exist',
    'created',
    'ready',
    'livestarting',
    'live',
    'complete'
];

const YOUTUBE_STATUS_MAP = {
    created: 'created',
    ready: 'ready',
    testStarting: 'teststarting',
    testing: 'testing',
    liveStarting: 'livestarting',
    live: 'live',
    complete: 'complete',
    revoked: 'revoked',
    lifeCycleStatusUnspecified: 'lifecyclestatusunspecified'
};

const STAGE_TO_MATRIX_KEY = {
    not_yet_set: 'NOT_YET_SET',
    not_exist: 'NOT_EXIST',
    created: 'CREATED',
    ready: 'READY',
    teststarting: 'TESTSTARTING',
    testing: 'TESTING',
    livestarting: 'LIVESTARTING',
    live: 'LIVE',
    complete: 'COMPLETE',
    revoked: 'REVOKED',
    lifecyclestatusunspecified: 'UNSPECIFIED'
};

const INTERNAL_TO_YOUTUBE = {
    teststarting: 'testStarting',
    livestarting: 'liveStarting',
    lifecyclestatusunspecified: 'lifeCycleStatusUnspecified'
};

const STARTING_STAGES = new Set(['teststarting', 'livestarting']);

const ERROR_STAGES = new Set(['revoked', 'lifecyclestatusunspecified']);

function normalizeStage(stage) {
    if (stage == null || stage === '') {
        return null;
    }
    return String(stage).toLowerCase();
}

function mapYouTubeStatus(lifeCycleStatus) {
    if (lifeCycleStatus == null) {
        return 'lifecyclestatusunspecified';
    }
    return YOUTUBE_STATUS_MAP[lifeCycleStatus] || 'lifecyclestatusunspecified';
}

function toMatrixKey(stage) {
    return STAGE_TO_MATRIX_KEY[normalizeStage(stage)] || 'UNSPECIFIED';
}

function stageIndex(stage, skipTesting) {
    const sequence = skipTesting ? CANONICAL_SEQUENCE_SKIP_TESTING : CANONICAL_SEQUENCE;
    const normalized = normalizeStage(stage);
    const index = sequence.indexOf(normalized);
    return index === -1 ? -1 : index;
}

function compareStages(a, b, skipTesting) {
    const indexA = stageIndex(a, skipTesting);
    const indexB = stageIndex(b, skipTesting);
    if (indexA === -1 || indexB === -1) {
        return null;
    }
    if (indexA < indexB) {
        return -1;
    }
    if (indexA > indexB) {
        return 1;
    }
    return 0;
}

function isValidGoal(goal) {
    const normalized = normalizeStage(goal);
    return VALID_GOALS.has(normalized);
}

function isInvalidGoal(goal) {
    const normalized = normalizeStage(goal);
    return INVALID_GOALS.has(normalized);
}

function isStartingStage(stage) {
    return STARTING_STAGES.has(normalizeStage(stage));
}

function isErrorStage(stage) {
    return ERROR_STAGES.has(normalizeStage(stage));
}

function toYouTubeLifeCycleStatus(stage) {
    const normalized = normalizeStage(stage);
    if (INTERNAL_TO_YOUTUBE[normalized]) {
        return INTERNAL_TO_YOUTUBE[normalized];
    }
    if (normalized === 'lifecyclestatusunspecified') {
        return 'lifeCycleStatusUnspecified';
    }
    return normalized;
}

function transitionRequiresBind(nextStage) {
    const normalized = normalizeStage(nextStage);
    return normalized === 'teststarting' || normalized === 'livestarting';
}

module.exports = {
    VALID_GOALS,
    INVALID_GOALS,
    CANONICAL_SEQUENCE,
    CANONICAL_SEQUENCE_SKIP_TESTING,
    normalizeStage,
    mapYouTubeStatus,
    toMatrixKey,
    stageIndex,
    compareStages,
    isValidGoal,
    isInvalidGoal,
    isStartingStage,
    isErrorStage,
    toYouTubeLifeCycleStatus,
    transitionRequiresBind
};
