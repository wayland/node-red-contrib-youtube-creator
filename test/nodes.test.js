'use strict';

const assert = require('assert');
const helper = require('node-red-node-test-helper');
const accountNode = require('../nodes/youtube-account.js');
const trackerNode = require('../nodes/youtube-stream-tracker.js');

describe('node registration', function () {
    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(function () {
            helper.stopServer(done);
        });
    });

    it('loads youtube-account and youtube-stream-tracker', async function () {
        const flow = [
            { id: 'account1', type: 'youtube-account', name: 'test account' },
            {
                id: 'tracker1',
                type: 'youtube-stream-tracker',
                name: 'test tracker',
                account: 'account1',
                wires: [[]]
            }
        ];
        await helper.load([accountNode, trackerNode], flow);
        const tracker = helper.getNode('tracker1');
        assert.ok(tracker);
        assert.strictEqual(tracker.currentStage, 'not_yet_set');
    });

    it('applies configure for stream title and poll intervals', async function () {
        const flow = [
            { id: 'account1', type: 'youtube-account', name: 'test account' },
            {
                id: 'tracker1',
                type: 'youtube-stream-tracker',
                name: 'test tracker',
                account: 'account1',
                streamTitle: 'Default stream',
                wires: [['helper1']]
            },
            { id: 'helper1', type: 'helper' }
        ];
        await helper.load([accountNode, trackerNode], flow);
        const tracker = helper.getNode('tracker1');
        const helperNode = helper.getNode('helper1');

        const configured = new Promise((resolve) => {
            helperNode.on('input', (msg) => {
                if (msg.payload.event === 'configured') {
                    resolve(msg.payload);
                }
            });
        });

        tracker.receive({
            payload: {
                action: 'configure',
                streamTitle: 'Sunday service',
                pollIntervalNormal: 45
            }
        });

        const event = await configured;
        assert.deepStrictEqual(event.updated, ['streamTitle', 'pollIntervalNormal']);
        assert.strictEqual(tracker.streamTitle, 'Sunday service');
        assert.strictEqual(tracker.pollIntervalNormal, 45);
    });

    it('exposes dynamic editor values for runtime state', async function () {
        const flow = [
            { id: 'account1', type: 'youtube-account', name: 'test account' },
            {
                id: 'tracker1',
                type: 'youtube-stream-tracker',
                name: 'test tracker',
                account: 'account1',
                broadcastId: 'configured-broadcast',
                streamId: 'configured-stream',
                wires: [[]]
            }
        ];
        await helper.load([accountNode, trackerNode], flow);
        const tracker = helper.getNode('tracker1');

        tracker.runtimeBroadcastId = 'runtime-broadcast';
        tracker.runtimeStreamId = 'runtime-stream';
        tracker.goalStage = 'live';
        tracker.currentStage = 'ready';
        tracker.inFlight = true;
        tracker.fatalError = true;

        assert.deepStrictEqual(tracker.getDynamicValues(), {
            name: 'test tracker',
            account: 'test account',
            broadcastId: 'runtime-broadcast',
            streamId: 'runtime-stream',
            broadcastTitle: 'Node-RED Live Broadcast',
            streamTitle: 'Node-RED Live Stream',
            skipTesting: false,
            pollIntervalNormal: 20,
            pollIntervalActive: 5,
            pollIntervalExpensive: 60,
            goalStage: 'live',
            currentStage: 'ready',
            inFlight: true,
            fatalError: true
        });
    });

    it('rejects configure with no recognized fields', async function () {
        const flow = [
            { id: 'account1', type: 'youtube-account', name: 'test account' },
            {
                id: 'tracker1',
                type: 'youtube-stream-tracker',
                account: 'account1',
                wires: [[]]
            }
        ];
        await helper.load([accountNode, trackerNode], flow);
        const tracker = helper.getNode('tracker1');
        let reported;

        tracker.error = function (err) {
            reported = err;
        };

        tracker.receive({
            payload: { action: 'configure' }
        });

        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(reported);
        assert.match(String(reported), /recognized setting field/);
    });
});
