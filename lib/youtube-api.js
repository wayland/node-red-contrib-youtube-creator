'use strict';

const { google } = require('googleapis');

const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';

function createOAuth2Client(clientId, clientSecret, redirectUri) {
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function buildAuthUrl(oauth2Client, state) {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [YOUTUBE_SCOPE],
        state
    });
}

function credentialsFromTokens(tokens) {
    return {
        accessToken: tokens.access_token || '',
        refreshToken: tokens.refresh_token || '',
        expiryDate: tokens.expiry_date != null ? String(tokens.expiry_date) : ''
    };
}

function applyCredentials(oauth2Client, credentials) {
    oauth2Client.setCredentials({
        access_token: credentials.accessToken,
        refresh_token: credentials.refreshToken,
        expiry_date: credentials.expiryDate ? Number(credentials.expiryDate) : undefined
    });
}

function createYouTubeClient(oauth2Client) {
    return google.youtube({ version: 'v3', auth: oauth2Client });
}

async function refreshIfNeeded(oauth2Client, credentials, onTokensUpdated) {
    const expiry = credentials.expiryDate ? Number(credentials.expiryDate) : 0;
    const needsRefresh = !credentials.accessToken || !expiry || Date.now() >= expiry - 60000;

    if (!needsRefresh) {
        applyCredentials(oauth2Client, credentials);
        return credentials;
    }

    if (!credentials.refreshToken) {
        throw new Error('Missing refresh token; re-authenticate the youtube-account node');
    }

    applyCredentials(oauth2Client, credentials);
    const { credentials: refreshed } = await oauth2Client.refreshAccessToken();
    const updated = credentialsFromTokens(refreshed);

    if (onTokensUpdated) {
        onTokensUpdated(updated);
    }

    oauth2Client.setCredentials(refreshed);
    return updated;
}

async function exchangeCode(oauth2Client, code) {
    const { tokens } = await oauth2Client.getToken(code);
    return credentialsFromTokens(tokens);
}

async function getLiveBroadcast(youtube, broadcastId) {
    const response = await youtube.liveBroadcasts.list({
        part: ['id', 'snippet', 'status', 'contentDetails'],
        id: [broadcastId],
        maxResults: 1
    });
    const items = response.data.items || [];
    if (items.length === 0) {
        const error = new Error(`Broadcast not found: ${broadcastId}`);
        error.code = 404;
        throw error;
    }
    return items[0];
}

async function createLiveBroadcast(youtube, { title, channelId, scheduledStartTime }) {
    const requestBody = {
        snippet: {
            title: title || 'Node-RED Live Broadcast',
            scheduledStartTime: scheduledStartTime || new Date(Date.now() + 600000).toISOString()
        },
        status: {
            privacyStatus: 'unlisted',
            selfDeclaredMadeForKids: false
        },
        contentDetails: {
            enableAutoStart: false,
            enableAutoStop: false
        }
    };

    if (channelId) {
        requestBody.snippet.channelId = channelId;
    }

    const response = await youtube.liveBroadcasts.insert({
        part: ['snippet', 'status', 'contentDetails'],
        requestBody
    });
    return response.data;
}

async function createLiveStream(youtube, { title }) {
    const response = await youtube.liveStreams.insert({
        part: ['snippet', 'cdn', 'status'],
        requestBody: {
            snippet: {
                title: title || 'Node-RED Live Stream'
            },
            cdn: {
                frameRate: 'variable',
                ingestionType: 'rtmp',
                resolution: 'variable'
            }
        }
    });
    return response.data;
}

async function transitionLiveBroadcast(youtube, broadcastId, broadcastStatus) {
    const response = await youtube.liveBroadcasts.transition({
        broadcastStatus,
        id: broadcastId,
        part: ['status']
    });
    return response.data;
}

function isBroadcastBound(broadcast, streamId) {
    const boundStreamId = broadcast?.contentDetails?.boundStreamId;
    if (!boundStreamId) {
        return false;
    }
    if (streamId) {
        return boundStreamId === streamId;
    }
    return true;
}

module.exports = {
    YOUTUBE_SCOPE,
    createOAuth2Client,
    buildAuthUrl,
    credentialsFromTokens,
    applyCredentials,
    createYouTubeClient,
    refreshIfNeeded,
    exchangeCode,
    getLiveBroadcast,
    createLiveBroadcast,
    createLiveStream,
    transitionLiveBroadcast,
    isBroadcastBound
};
