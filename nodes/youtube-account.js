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

    function credentialsForNode(id, accountNode) {
        return (accountNode && accountNode.credentials) || RED.nodes.getCredentials(id) || {};
    }

    function createOAuth2Client(id, accountNode, redirectUri) {
        const creds = credentialsForNode(id, accountNode);
        if (!creds.clientId || !creds.clientSecret) {
            throw new Error('OAuth client id and secret are required');
        }
        return api.createOAuth2Client(creds.clientId, creds.clientSecret, redirectUri || accountNode?.getRedirectUri());
    }

    function saveTokens(id, accountNode, tokens) {
        const merged = {
            ...credentialsForNode(id, accountNode),
            ...tokens
        };
        RED.nodes.addCredentials(id, merged);
        if (accountNode) {
            accountNode.credentials = merged;
            accountNode.connected = !!(merged.accessToken && merged.refreshToken);
            accountNode.authError = null;
        }
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
            saveTokens(node.id, node, tokens);
        };

        node.getOAuth2Client = function (redirectUri) {
            return createOAuth2Client(node.id, node, redirectUri || node.getRedirectUri());
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
            const creds = RED.nodes.getCredentials(req.params.id);
            if (!creds) {
                res.status(404).send('Unknown youtube-account node. Click Done and Deploy before using Authenticate.');
                return;
            }
        }

        try {
            const redirectUri = redirectUriFromOrigin(requestOrigin(req));
            const oauth2Client = createOAuth2Client(req.params.id, accountNode, redirectUri);
            const state = `${req.params.id}:${Date.now()}`;
            pendingAuth.set(state, {
                nodeId: req.params.id,
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

        (async () => {
            try {
                const oauth2Client = createOAuth2Client(pending.nodeId, accountNode, pending.redirectUri);
                const tokens = await api.exchangeCode(oauth2Client, code);
                if (!tokens.refreshToken) {
                    res.status(400).send('No refresh token received; revoke prior access and authenticate again with prompt=consent');
                    return;
                }
                saveTokens(pending.nodeId, accountNode, tokens);
                res.send('<html><body><h2>YouTube account connected</h2><p>You can close this window and deploy your flows.</p></body></html>');
            } catch (err) {
                res.status(500).send(`Token exchange failed: ${err.message}`);
            }
        })();
    });

    RED.httpAdmin.get('/youtube-account/status/:id', RED.auth.needsPermission('flows.read'), function (req, res) {
        const accountNode = RED.nodes.getNode(req.params.id);
        if (!accountNode || accountNode.type !== 'youtube-account') {
            const creds = RED.nodes.getCredentials(req.params.id);
            if (creds) {
                res.json({
                    connected: false,
                    error: null,
                    hasClientId: !!creds.clientId,
                    hasClientSecret: !!creds.clientSecret,
                    hasTokens: !!creds.accessToken
                });
                return;
            }
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
