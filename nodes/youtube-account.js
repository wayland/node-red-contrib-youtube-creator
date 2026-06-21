'use strict';

const api = require('../lib/youtube-api');

module.exports = function (RED) {
    const AUTH_CALLBACK_PATH = '/youtube-account/auth/callback';
    const pendingAuth = new Map();

    function normalizedAdminRoot() {
        const root = RED.settings.httpAdminRoot || '/';
        return root.endsWith('/') ? root.slice(0, -1) : root;
    }

    function requestOrigin(req) {
        const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
        const host = req.get('x-forwarded-host') || req.get('host');
        return `${protocol}://${normalizeLoopbackHost(host)}`;
    }

    function normalizeLoopbackHost(host) {
        return String(host || '').replace(/^((?:https?:\/\/)?)127\.0\.0\.1(?=(:|$))/, '$1localhost');
    }

    function redirectUriFromOrigin(origin) {
        return `${normalizeLoopbackHost(origin)}${normalizedAdminRoot()}${AUTH_CALLBACK_PATH}`;
    }

    function YoutubeAccountNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name || '';
        node.channelId = config.channelId || '';
        node.connected = false;
        node.authError = null;

        node.getRedirectUri = function (origin) {
            if (origin) {
                return redirectUriFromOrigin(origin);
            }
            return `${normalizedAdminRoot()}${AUTH_CALLBACK_PATH}`;
        };

        node.saveTokens = function (tokens) {
            const merged = {
                ...(node.credentials || {}),
                ...tokens
            };
            RED.nodes.addCredentials(node, merged);
            node.credentials = merged;
            node.connected = !!(merged.accessToken && merged.refreshToken);
            node.authError = null;
        };

        node.getOAuth2Client = function (redirectUri) {
            const creds = node.credentials || {};
            if (!creds.clientId || !creds.clientSecret) {
                throw new Error('OAuth client id and secret are required');
            }
            return api.createOAuth2Client(creds.clientId, creds.clientSecret, redirectUri || node.getRedirectUri());
        };

        node.getYouTubeClient = async function () {
            const creds = node.credentials || {};
            if (!creds.clientId || !creds.clientSecret) {
                throw new Error('OAuth client id and secret are required');
            }
            if (!creds.accessToken && !creds.refreshToken) {
                throw new Error('Account not authenticated; use Authenticate on the youtube-account config node');
            }

            const oauth2Client = node.getOAuth2Client();
            await api.refreshIfNeeded(oauth2Client, creds, (updated) => {
                node.saveTokens(updated);
            });
            return api.createYouTubeClient(oauth2Client);
        };

        node.validateAuth = async function () {
            try {
                await node.getYouTubeClient();
                node.connected = true;
                node.authError = null;
                return true;
            } catch (err) {
                node.connected = false;
                node.authError = err.message;
                return false;
            }
        };

        node.on('close', () => {
            pendingAuth.delete(node.id);
        });

        node.validateAuth().catch(() => {});
    }

    RED.nodes.registerType('youtube-account', YoutubeAccountNode, {
        credentials: {
            clientId: { type: 'text' },
            clientSecret: { type: 'password' },
            accessToken: { type: 'password' },
            refreshToken: { type: 'password' },
            expiryDate: { type: 'text' }
        }
    });

    RED.httpAdmin.get('/youtube-account/auth/:id', RED.auth.needsPermission('flows.write'), function (req, res) {
        const accountNode = RED.nodes.getNode(req.params.id);
        if (!accountNode || accountNode.type !== 'youtube-account') {
            res.status(404).send('Unknown youtube-account node. Click Done and Deploy before using Authenticate.');
            return;
        }

        try {
            const redirectUri = accountNode.getRedirectUri(requestOrigin(req));
            const oauth2Client = accountNode.getOAuth2Client(redirectUri);
            const state = `${accountNode.id}:${Date.now()}`;
            pendingAuth.set(state, {
                nodeId: accountNode.id,
                redirectUri
            });
            res.redirect(api.buildAuthUrl(oauth2Client, state));
        } catch (err) {
            res.status(400).send(err.message);
        }
    });

    RED.httpAdmin.get(AUTH_CALLBACK_PATH, function (req, res) {
        const code = req.query.code;
        const state = req.query.state;
        const error = req.query.error;

        if (error) {
            res.status(400).send(`Authentication failed: ${error}`);
            return;
        }

        if (!code || !state) {
            res.status(400).send('Missing OAuth code or state');
            return;
        }

        const pending = pendingAuth.get(state);
        pendingAuth.delete(state);
        if (!pending) {
            res.status(400).send('OAuth state expired or invalid; start authentication again');
            return;
        }

        const accountNode = RED.nodes.getNode(pending.nodeId);
        if (!accountNode) {
            res.status(404).send('youtube-account node no longer exists');
            return;
        }

        (async () => {
            try {
                const oauth2Client = accountNode.getOAuth2Client(pending.redirectUri);
                const tokens = await api.exchangeCode(oauth2Client, code);
                if (!tokens.refreshToken) {
                    res.status(400).send('No refresh token received; revoke prior access and authenticate again with prompt=consent');
                    return;
                }
                accountNode.saveTokens(tokens);
                res.send('<html><body><h2>YouTube account connected</h2><p>You can close this window and deploy your flows.</p></body></html>');
            } catch (err) {
                res.status(500).send(`Token exchange failed: ${err.message}`);
            }
        })();
    });

    RED.httpAdmin.get('/youtube-account/status/:id', RED.auth.needsPermission('flows.read'), function (req, res) {
        const accountNode = RED.nodes.getNode(req.params.id);
        if (!accountNode || accountNode.type !== 'youtube-account') {
            res.status(404).json({
                connected: false,
                error: 'Unknown youtube-account node. Click Done and Deploy before using Authenticate.'
            });
            return;
        }
        res.json({
            connected: accountNode.connected,
            error: accountNode.authError,
            hasClientId: !!(accountNode.credentials && accountNode.credentials.clientId),
            hasClientSecret: !!(accountNode.credentials && accountNode.credentials.has_clientSecret),
            hasTokens: !!(accountNode.credentials && accountNode.credentials.has_accessToken)
        });
    });
};
