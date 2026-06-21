'use strict';

const stages = require('../lib/stages');
const transition = require('../lib/transition');
const api = require('../lib/youtube-api');

module.exports = function (RED) {
    const DEFAULT_POLL_NORMAL = 20;
    const DEFAULT_POLL_ACTIVE = 5;
    const DEFAULT_POLL_EXPENSIVE = 60;

    function YoutubeStreamTrackerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.account = RED.nodes.getNode(config.account);
        node.broadcastId = config.broadcastId || '';
        node.streamId = config.streamId || '';
        node.broadcastTitle = config.broadcastTitle || 'Node-RED Live Broadcast';
        node.streamTitle = config.streamTitle || 'Node-RED Live Stream';
        node.skipTesting = config.skipTesting === true || config.skipTesting === 'true';
        node.pollIntervalNormal = Number(config.pollIntervalNormal) || DEFAULT_POLL_NORMAL;
        node.pollIntervalActive = Number(config.pollIntervalActive) || DEFAULT_POLL_ACTIVE;
        node.pollIntervalExpensive = Number(config.pollIntervalExpensive) || DEFAULT_POLL_EXPENSIVE;

        node.currentStage = 'not_yet_set';
        node.goalStage = null;
        node.bound = false;
        node.youtubeLifeCycleStatus = null;
        node.lastBroadcast = null;
        node.inFlight = false;
        node.awaitingStage = null;
        node.goalReachedFor = null;
        node.lastBindWarningGoal = null;
        node.fatalError = false;
        node.pollTimer = null;
        node.useExpensivePoll = false;

        node.runtimeBroadcastId = node.broadcastId;
        node.runtimeStreamId = node.streamId;

        node.getDynamicValues = function () {
            return {
                name: node.name || '',
                account: node.account ? (node.account.name || node.account.id) : '',
                broadcastId: node.runtimeBroadcastId || '',
                streamId: node.runtimeStreamId || '',
                broadcastTitle: node.broadcastTitle,
                streamTitle: node.streamTitle,
                skipTesting: node.skipTesting,
                pollIntervalNormal: node.pollIntervalNormal,
                pollIntervalActive: node.pollIntervalActive,
                pollIntervalExpensive: node.pollIntervalExpensive,
                goalStage: node.goalStage,
                currentStage: node.currentStage,
                inFlight: node.inFlight,
                fatalError: node.fatalError
            };
        };

        function timestamp() {
            return new Date().toISOString();
        }

        function basePayload(event) {
            return {
                event,
                current_stage: node.currentStage,
                goal_stage: node.goalStage,
                youtube_lifeCycleStatus: node.youtubeLifeCycleStatus,
                broadcastId: node.runtimeBroadcastId || undefined,
                streamId: node.runtimeStreamId || undefined,
                bound: node.bound,
                account: node.account ? (node.account.name || node.account.id) : undefined,
                timestamp: timestamp()
            };
        }

        function sendStatus(event, extra) {
            const outMsg = {
                payload: {
                    ...basePayload(event),
                    ...(extra || {})
                }
            };
            node.send(outMsg);
        }

        function applyConfigure(payload) {
            const updated = [];

            if (payload.broadcastId !== undefined) {
                node.broadcastId = String(payload.broadcastId);
                node.runtimeBroadcastId = node.broadcastId;
                updated.push('broadcastId');
            }
            if (payload.streamId !== undefined) {
                node.streamId = String(payload.streamId);
                node.runtimeStreamId = node.streamId;
                updated.push('streamId');
            }
            if (payload.broadcastTitle !== undefined) {
                node.broadcastTitle = String(payload.broadcastTitle);
                updated.push('broadcastTitle');
            }
            if (payload.streamTitle !== undefined) {
                node.streamTitle = String(payload.streamTitle);
                updated.push('streamTitle');
            }
            if (payload.skipTesting !== undefined) {
                node.skipTesting = payload.skipTesting === true || payload.skipTesting === 'true';
                updated.push('skipTesting');
            }
            if (payload.pollIntervalNormal !== undefined) {
                const seconds = Number(payload.pollIntervalNormal);
                if (!Number.isFinite(seconds) || seconds < 1) {
                    throw new Error('pollIntervalNormal must be a number >= 1');
                }
                node.pollIntervalNormal = seconds;
                updated.push('pollIntervalNormal');
            }
            if (payload.pollIntervalActive !== undefined) {
                const seconds = Number(payload.pollIntervalActive);
                if (!Number.isFinite(seconds) || seconds < 1) {
                    throw new Error('pollIntervalActive must be a number >= 1');
                }
                node.pollIntervalActive = seconds;
                updated.push('pollIntervalActive');
            }
            if (payload.pollIntervalExpensive !== undefined) {
                const seconds = Number(payload.pollIntervalExpensive);
                if (!Number.isFinite(seconds) || seconds < 1) {
                    throw new Error('pollIntervalExpensive must be a number >= 1');
                }
                node.pollIntervalExpensive = seconds;
                updated.push('pollIntervalExpensive');
            }

            return updated;
        }

        function isPollOnlyStep(currentStage, nextStage) {
            const current = stages.normalizeStage(currentStage);
            const next = stages.normalizeStage(nextStage);
            return (
                (current === 'created' && next === 'ready') ||
                (current === 'teststarting' && next === 'testing') ||
                (current === 'livestarting' && next === 'live')
            );
        }

        function applySyntheticAdvance(nextStage) {
            const next = stages.normalizeStage(nextStage);
            if (node.currentStage === 'not_yet_set' && next === 'not_exist' && !node.runtimeBroadcastId) {
                const previous = node.currentStage;
                node.currentStage = 'not_exist';
                sendStatus('stage_changed', {
                    previous_stage: previous,
                    current_stage: node.currentStage
                });
                return true;
            }
            return false;
        }

        function isApiActionRequired(currentStage, nextStage) {
            const next = stages.normalizeStage(nextStage);
            if (isPollOnlyStep(currentStage, nextStage)) {
                return false;
            }
            return next === 'created' || youtubeTransitionStatus(next) != null;
        }

        function clearPollTimer() {
            if (node.pollTimer) {
                clearTimeout(node.pollTimer);
                node.pollTimer = null;
            }
        }

        function pollIntervalSeconds() {
            if (node.useExpensivePoll) {
                return node.pollIntervalExpensive;
            }
            if (node.awaitingStage || stages.isStartingStage(node.currentStage)) {
                return node.pollIntervalActive;
            }
            return node.pollIntervalNormal;
        }

        function schedulePoll(delaySeconds) {
            clearPollTimer();
            const seconds = delaySeconds != null ? delaySeconds : pollIntervalSeconds();
            node.pollTimer = setTimeout(() => {
                node.pollTimer = null;
                node.tick(true).catch((err) => {
                    node.error(err.message, {});
                });
            }, seconds * 1000);
        }

        async function getYouTube() {
            if (!node.account) {
                throw new Error('No youtube-account configured');
            }
            return node.account.getYouTubeClient();
        }

        async function pollYouTube() {
            if (!node.runtimeBroadcastId) {
                if (node.currentStage === 'not_yet_set') {
                    node.currentStage = node.broadcastId ? 'not_exist' : 'not_yet_set';
                } else if (node.broadcastId && !node.runtimeBroadcastId) {
                    node.currentStage = 'not_exist';
                }
                node.youtubeLifeCycleStatus = null;
                node.bound = false;
                node.lastBroadcast = null;
                return;
            }

            const youtube = await getYouTube();
            try {
                const broadcast = await api.getLiveBroadcast(youtube, node.runtimeBroadcastId);
                node.lastBroadcast = broadcast;
                const lifeCycleStatus = broadcast.status?.lifeCycleStatus;
                node.youtubeLifeCycleStatus = lifeCycleStatus;
                const mapped = stages.mapYouTubeStatus(lifeCycleStatus);
                node.currentStage = mapped;
                node.bound = api.isBroadcastBound(broadcast, node.runtimeStreamId);
                node.useExpensivePoll = mapped === 'complete';
            } catch (err) {
                if (err.code === 404) {
                    node.currentStage = 'not_exist';
                    node.youtubeLifeCycleStatus = null;
                    node.bound = false;
                    node.lastBroadcast = null;
                    return;
                }
                throw err;
            }
        }

        async function ensureStreamExists(youtube) {
            if (node.runtimeStreamId) {
                return node.runtimeStreamId;
            }
            sendStatus('youtube_action_started', {
                youtube_method: 'liveStreams.insert'
            });
            const stream = await api.createLiveStream(youtube, {
                title: node.streamTitle
            });
            node.runtimeStreamId = stream.id;
            sendStatus('youtube_action_done', {
                youtube_method: 'liveStreams.insert',
                streamId: stream.id
            });
            return stream.id;
        }

        async function createBroadcastResources(youtube) {
            await ensureStreamExists(youtube);
            sendStatus('youtube_action_started', {
                youtube_method: 'liveBroadcasts.insert'
            });
            const broadcast = await api.createLiveBroadcast(youtube, {
                title: node.broadcastTitle,
                channelId: node.account?.channelId
            });
            node.runtimeBroadcastId = broadcast.id;
            node.currentStage = stages.mapYouTubeStatus(broadcast.status?.lifeCycleStatus) || 'created';
            node.youtubeLifeCycleStatus = broadcast.status?.lifeCycleStatus || 'created';
            sendStatus('youtube_action_done', {
                youtube_method: 'liveBroadcasts.insert',
                broadcastId: broadcast.id
            });
            node.awaitingStage = 'ready';
        }

        function youtubeTransitionStatus(nextStage) {
            const normalized = stages.normalizeStage(nextStage);
            if (normalized === 'teststarting') {
                return 'testing';
            }
            if (normalized === 'livestarting') {
                return 'live';
            }
            if (normalized === 'complete') {
                return 'complete';
            }
            return null;
        }

        async function performTransitionAction(nextStage) {
            const youtube = await getYouTube();
            const normalized = stages.normalizeStage(nextStage);

            if (normalized === 'created') {
                await createBroadcastResources(youtube);
                return;
            }

            const broadcastStatus = youtubeTransitionStatus(normalized);
            if (!broadcastStatus) {
                node.awaitingStage = normalized;
                return;
            }

            if (!node.runtimeBroadcastId) {
                throw new Error('Cannot transition without a broadcast id');
            }

            sendStatus('youtube_action_started', {
                youtube_method: 'liveBroadcasts.transition',
                broadcastStatus
            });

            try {
                const result = await api.transitionLiveBroadcast(
                    youtube,
                    node.runtimeBroadcastId,
                    broadcastStatus
                );
                node.youtubeLifeCycleStatus = result.status?.lifeCycleStatus || node.youtubeLifeCycleStatus;
                sendStatus('youtube_action_done', {
                    youtube_method: 'liveBroadcasts.transition',
                    broadcastStatus
                });
                if (normalized === 'teststarting') {
                    node.awaitingStage = 'teststarting';
                } else if (normalized === 'livestarting') {
                    node.awaitingStage = 'livestarting';
                } else if (normalized === 'complete') {
                    node.awaitingStage = 'complete';
                }
            } catch (err) {
                sendStatus('youtube_action_failed', {
                    youtube_method: 'liveBroadcasts.transition',
                    broadcastStatus,
                    error: err.message
                });
                throw err;
            }
        }

        function shouldAdvance(current, next) {
            const cmp = stages.compareStages(current, next, node.skipTesting);
            return cmp != null && cmp < 0;
        }

        async function processGoal() {
            if (node.fatalError || node.inFlight || !node.goalStage) {
                return;
            }

            if (!node.account) {
                node.fatalError = true;
                sendStatus('error', { message: 'No youtube-account configured' });
                return;
            }

            try {
                await node.account.validateAuth();
                if (node.account.authError) {
                    node.fatalError = true;
                    sendStatus('error', { message: node.account.authError });
                    return;
                }
            } catch (err) {
                node.fatalError = true;
                sendStatus('error', { message: err.message });
                return;
            }

            if (stages.isErrorStage(node.currentStage)) {
                node.fatalError = true;
                sendStatus('error', {
                    message: "Can't handle the stream status",
                    current_stage: node.currentStage
                });
                return;
            }

            const cmp = stages.compareStages(node.currentStage, node.goalStage, node.skipTesting);
            if (cmp != null && cmp > 0) {
                sendStatus('notice', {
                    message: 'Stream is ahead of schedule',
                    current_stage: node.currentStage,
                    goal_stage: node.goalStage
                });
                return;
            }

            if (cmp === 0) {
                if (node.goalReachedFor !== node.goalStage) {
                    node.goalReachedFor = node.goalStage;
                    sendStatus('goal_reached', {
                        current_stage: node.currentStage,
                        goal_stage: node.goalStage
                    });
                }
                return;
            }

            const plan = transition.lookupTransition(node.currentStage, node.goalStage, node.skipTesting);
            if (plan.action === 'notice') {
                sendStatus('notice', {
                    message: plan.message,
                    current_stage: node.currentStage,
                    goal_stage: node.goalStage
                });
                return;
            }

            if (plan.action === 'error') {
                node.fatalError = true;
                sendStatus('error', {
                    message: plan.message,
                    current_stage: node.currentStage
                });
                return;
            }

            const nextStage = plan.next_stage;
            if (!shouldAdvance(node.currentStage, nextStage)) {
                if (node.awaitingStage && node.currentStage === node.awaitingStage) {
                    node.awaitingStage = null;
                }
                return;
            }

            if (stages.transitionRequiresBind(nextStage) && !node.bound) {
                if (node.lastBindWarningGoal !== node.goalStage) {
                    node.lastBindWarningGoal = node.goalStage;
                    sendStatus('warning', {
                        code: 'bind_required',
                        message: 'Broadcast is not bound to stream; bind must be done externally before testing or live',
                        broadcastId: node.runtimeBroadcastId,
                        streamId: node.runtimeStreamId,
                        current_stage: node.currentStage,
                        goal_stage: node.goalStage
                    });
                }
                return;
            }

            node.lastBindWarningGoal = null;

            const broadcastStatus = youtubeTransitionStatus(nextStage);
            sendStatus('transition_planned', {
                current_stage: node.currentStage,
                next_stage: nextStage,
                goal_stage: plan.goal_stage,
                youtube_method: broadcastStatus ? 'liveBroadcasts.transition' : undefined,
                broadcastStatus: broadcastStatus || undefined
            });

            if (!isApiActionRequired(node.currentStage, nextStage)) {
                if (applySyntheticAdvance(nextStage)) {
                    await processGoal();
                    return;
                }
                node.awaitingStage = nextStage;
                return;
            }

            node.inFlight = true;
            try {
                await performTransitionAction(nextStage);
            } finally {
                node.inFlight = false;
            }
        }

        node.tick = async function (fromPoll) {
            const previousStage = node.currentStage;

            try {
                await pollYouTube();
            } catch (err) {
                sendStatus('error', { message: err.message });
                schedulePoll();
                return;
            }

            if (fromPoll && previousStage !== node.currentStage) {
                sendStatus('stage_changed', {
                    previous_stage: previousStage,
                    current_stage: node.currentStage
                });
            }

            if (node.awaitingStage && node.currentStage === node.awaitingStage) {
                node.awaitingStage = null;
            }

            await processGoal();
            schedulePoll();
        };

        node.on('input', async function (msg, send, done) {
            const payload = msg.payload || {};
            const action = payload.action;

            try {
                if (action === 'set_goal') {
                    const goal = stages.normalizeStage(payload.goal);
                    if (!goal) {
                        done('set_goal requires a goal field');
                        return;
                    }
                    if (stages.isInvalidGoal(goal)) {
                        sendStatus('error', {
                            message: "Can't handle the stream status",
                            current_stage: goal
                        });
                        done();
                        return;
                    }
                    if (!stages.isValidGoal(goal)) {
                        done(`Invalid goal: ${goal}`);
                        return;
                    }
                    if (stages.isErrorStage(node.currentStage)) {
                        node.fatalError = true;
                        sendStatus('error', {
                            message: "Can't handle the stream status",
                            current_stage: node.currentStage
                        });
                        done();
                        return;
                    }

                    node.goalStage = goal;
                    node.goalReachedFor = null;
                    node.fatalError = false;
                    sendStatus('goal_set', { goal_stage: goal });
                    await node.tick(false);
                } else if (action === 'configure') {
                    const updated = applyConfigure(payload);
                    if (updated.length === 0) {
                        done('configure requires at least one recognized setting field');
                        return;
                    }
                    sendStatus('configured', { updated });
                } else if (action === 'sync') {
                    await node.tick(true);
                } else if (action === 'reset') {
                    node.goalStage = null;
                    node.goalReachedFor = null;
                    node.inFlight = false;
                    node.awaitingStage = null;
                    node.lastBindWarningGoal = null;
                    node.fatalError = false;
                    node.currentStage = 'not_yet_set';
                    node.runtimeBroadcastId = node.broadcastId;
                    node.runtimeStreamId = node.streamId;
                    if (payload.pollNow) {
                        await node.tick(true);
                    } else {
                        schedulePoll();
                    }
                } else {
                    done(`Unknown action: ${action}`);
                    return;
                }
                done();
            } catch (err) {
                done(err);
            }
        });

        node.on('close', function () {
            clearPollTimer();
        });

        schedulePoll(1);
    }

    RED.nodes.registerType('youtube-stream-tracker', YoutubeStreamTrackerNode);

    RED.httpAdmin.get(
        '/youtube-stream-tracker/status/:id',
        RED.auth.needsPermission('flows.read'),
        function (req, res) {
            const trackerNode = RED.nodes.getNode(req.params.id);
            if (!trackerNode || trackerNode.type !== 'youtube-stream-tracker') {
                res.status(404).json({ error: 'Unknown youtube-stream-tracker node' });
                return;
            }
            res.json(trackerNode.getDynamicValues());
        }
    );
};
