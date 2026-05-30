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
});
