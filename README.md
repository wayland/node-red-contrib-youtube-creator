# node-red-contrib-youtube-stream-tracker

Custom Node-RED nodes for tracking and driving a YouTube Live broadcast’s `lifeCycleStatus`.

## Overview

This package provides two nodes:

| Node | Kind | Role |
| --- | --- | --- |
| **youtube-account** | Configuration node | Shared OAuth credentials and token refresh for YouTube Data API v3 |
| **youtube-stream-tracker** | Flow node | Polls one broadcast, steps through lifecycle stages toward a goal, emits status messages |

The split follows the same pattern as Node-RED’s MQTT broker + MQTT nodes: configure the account once, reference it from one or more trackers.

Behaviour, lifecycle stages, and transition rules are defined in [TrackerSpecification.md](./TrackerSpecification.md). YouTube-side staging is described in Google’s [Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast).

## Requirements

- Node-RED **3.0+**
- Node.js **18+**
- A Google Cloud OAuth client with YouTube Data API v3 enabled
- A YouTube channel with live streaming enabled (OAuth user account — **not** a service account)

## Installation

From your Node-RED user directory (usually `~/.node-red`):

```bash
npm install /path/to/node-red-contrib-youtube-stream-tracker
```

Or, while developing locally:

```bash
cd ~/.node-red
npm install /home/wayland/src/node-red/node-red-contrib-youtube-creator
```

Restart Node-RED and deploy. The **youtube-stream-tracker** node appears under the **social** category. **youtube-account** is added from **Configuration nodes**.

## Prerequisites (before OAuth)

The Google account used for OAuth must already be eligible to live stream:

- Channel verified; no live streaming restrictions in the past 90 days ([Get started with live streaming](https://support.google.com/youtube/answer/2474026))
- Live streaming enabled on the channel (first-time enablement can take up to 24 hours — [Create a live stream with an encoder](https://support.google.com/youtube/answer/2907883))
- If API calls return `insufficientPermissions`, the channel may not be eligible ([Live Streaming API authentication](https://developers.google.com/youtube/v3/live/authentication))

**Service accounts are not supported.** They yield `NoLinkedYouTubeAccount` ([YouTube authentication guide](https://developers.google.com/youtube/v3/guides/authentication)).

## OAuth and Google Cloud setup

### 1. Google Cloud project

1. Sign in to [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project ([Getting started](https://developers.google.com/youtube/v3/getting-started)).

### 2. Enable the API

1. Open [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
2. Enable it for your project.

Live streaming uses the same YouTube Data API v3 (`liveBroadcast`, `liveStream`, etc.).

### 3. OAuth consent screen

1. Configure the consent screen in [Google Auth platform](https://console.cloud.google.com/auth/overview).
2. Choose **Internal** or **External**.
3. For **External** apps in **Testing**, add each authorizing Google account as a **test user**.
4. Under **Data access**, add the scope below.

### 4. OAuth client credentials

1. Open [Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth client ID** of type **Web application**.
3. Add this **Authorized redirect URI** (adjust host/port if your Node-RED admin URL differs):

   ```text
   http://127.0.0.1:1880/youtube-account/auth/callback
   ```

   The path is `{httpAdminRoot}/youtube-account/auth/callback`. The youtube-account editor shows the exact URI for your instance.

4. Save the **Client ID** and **Client secret** for the config node.

### 5. Scopes

This package requests a single write scope:

```text
https://www.googleapis.com/auth/youtube
```

- Do **not** combine `youtube` with `youtube.readonly`.
- Do **not** request multiple overlapping YouTube write scopes.
- `youtube.readonly` alone cannot create broadcasts or run transitions.

### 6. Authorize in Node-RED

1. Open **Configuration nodes** → add or edit **youtube-account**.
2. Enter **Client ID** and **Client secret**.
3. Click **Authenticate** and complete Google sign-in with the channel owner account.
4. Confirm redirect back to Node-RED succeeds.
5. **Deploy** flows. Tokens are stored encrypted in Node-RED credentials.
6. Optionally set **Channel ID** when the Google account manages multiple channels.

### 7. Verify auth

- The account config status shows **Connected** after deploy.
- A **youtube-stream-tracker** with a known `broadcastId` should poll without auth `error` events and emit `stage_changed` when status changes.

### OAuth troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `redirect_uri_mismatch` | Redirect URI not registered or typo | Match URI exactly in Cloud Console |
| Access blocked / app not verified | External app in Testing, user not listed | Add user as test user on consent screen |
| `NoLinkedYouTubeAccount` | Service account used | Use OAuth user flow |
| `insufficientPermissions` | Channel not live-enabled | Complete YouTube live streaming enablement |
| `invalid_scope` | Conflicting scopes | Request only one write scope |
| Token expired / repeated prompts | Refresh token missing or revoked | Re-authenticate |
| `403` quota | API quota exhausted | [Reduce quota use](https://developers.google.com/youtube/v3/getting-started#quota); increase poll intervals |

Encoder and stream-key issues: [Troubleshoot your YouTube live stream](https://support.google.com/youtube/answer/2853835).

## Configuring youtube-account

- Edit from **Configuration nodes** (hamburger menu → Configuration nodes) or from a tracker’s account dropdown.
- **Name** — label in dropdowns.
- **Channel ID** — optional default when creating broadcasts.
- **Client ID / Client secret** — OAuth credentials (encrypted).
- **Authenticate** — runs the OAuth consent flow.

One account config can be shared by multiple trackers. Re-run **Authenticate** to rotate tokens or after revoking access.

**Do not** commit `flows_cred.json` or credential backups to git.

## Configuring youtube-stream-tracker

| Field | Description |
| --- | --- |
| Account | Required reference to a youtube-account config node |
| Broadcast ID | Existing broadcast; omit to create when advancing toward `created`+ |
| Stream ID | Existing stream; omit to create when needed |
| Broadcast / stream title | Used when creating resources |
| Skip testing stage | From `ready`, advance toward live via `livestarting` (skip `teststarting` / `testing`) |
| Poll intervals | Normal (20s), active (5s), expensive (60s) defaults |

### Input messages (`msg.payload`)

Set a goal:

```json
{ "action": "set_goal", "goal": "live" }
```

Valid goals: `not_yet_set`, `not_exist`, `created`, `ready`, `teststarting`, `testing`, `livestarting`, `live`, `complete`.

Force sync:

```json
{ "action": "sync" }
```

Reset internal state:

```json
{ "action": "reset", "pollNow": true }
```

### Output events

The single output emits status messages, including:

- `stage_changed`, `goal_set`, `goal_reached`
- `transition_planned`, `youtube_action_started`, `youtube_action_done`, `youtube_action_failed`
- `notice` — e.g. goal behind current stage
- `warning` — `code: "bind_required"` when bind is needed externally
- `error` — auth failure, `revoked`, or unhandled status

Example:

```json
{
  "event": "stage_changed",
  "current_stage": "ready",
  "goal_stage": "testing",
  "youtube_lifeCycleStatus": "ready",
  "bound": false,
  "timestamp": "2026-05-30T12:00:00.000Z"
}
```

### Example wiring

```text
[ schedule / UI ] ──set_goal──► [ youtube-stream-tracker ] ──status──► [ dashboard ]
                                         │
                                         account: youtube-account
```

Optional external flows can listen for `bind_required` or stage changes to run [`liveBroadcasts.bind`](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind), start RTMP ingest (OBS, encoder, etc.), or update dashboards. The tracker does not perform bind or ingest itself.

## External steps (bind, ingest)

- **Bind** links the broadcast resource to the stream resource on YouTube ([API docs](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind), [encoder setup](https://support.google.com/youtube/answer/2907883)).
- **Ingest** sends encoded video to the stream’s RTMP URL (external hardware/software).

The tracker warns with `bind_required` when progression needs bind; it never calls `liveBroadcasts.bind`.

## Operations and quota

Default polling: 20s normal, 5s during `testStarting` / `liveStarting` (or after API transitions), 60s when in `complete`.

`liveBroadcasts.list` / `get` and `transition` consume [YouTube API quota](https://developers.google.com/youtube/v3/getting-started#quota). Increase `pollIntervalExpensive` or `pollIntervalNormal` if you hit quota limits.

## Security and privacy

- OAuth tokens and client secrets are stored in Node-RED’s encrypted credentials store.
- Only the `https://www.googleapis.com/auth/youtube` scope is requested.
- Restrict access to the Node-RED editor and Configuration nodes to trusted operators.

## Development

```bash
npm install
npm test
```

## License

Apache-2.0
