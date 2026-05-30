# YouTube Tracker: custom Node-RED nodes for Live `lifeCycleStatus`

## Goal

Track and drive a YouTube Live broadcast’s `liveBroadcast.status.lifeCycleStatus` using **custom Node-RED nodes** in a single package (`node-red-contrib-youtube-stream-tracker`, name TBD).

This document is the **canonical specification** for that package: lifecycle stages, transition matrix, polling, node surfaces, and user-documentation requirements.

A **youtube-stream-tracker** flow node embeds the lifecycle state machine, polls YouTube, and issues in-scope API calls. It emits **status change messages** on its output. Other flows may listen and take **external** actions (bind, ingest, dashboards, etc.) — possible outside the node, but not implemented by it.

Source of truth for lifecycle values: the YouTube Live Streaming API `liveBroadcast` resource (`status.lifeCycleStatus`) at [`liveBroadcasts`](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts). Broadcast “staging” behavior (`testStarting`, `liveStarting`) is described in [Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast).

## Approach (brief)

The package follows the same **config node + flow node** pattern as Node-RED’s built-in MQTT nodes:

| Node | Node-RED kind | Palette? | Role |
| --- | --- | --- | --- |
| **youtube-account** | Configuration node | No — edit via **Configuration nodes** or when adding a tracker | Shared YouTube API access: OAuth, tokens, refresh, scopes |
| **youtube-stream-tracker** | Flow node | Yes | One broadcast lifecycle: poll, transitions, status output |

- One **youtube-account** config can be shared by multiple flow nodes (tracker, future bind helper, etc.).
- One **youtube-stream-tracker** instance tracks **one** broadcast (and its associated stream).
- An **input message** on the tracker sets the **goal stage** (`action: "set_goal"`, `goal: "<stage>"`).
- The tracker maintains **current stage** (synced from YouTube) and **goal stage** (from input).
- On each poll (or after handling input), the tracker performs the **next in-scope YouTube API action** (if any) toward the goal, using the referenced account’s authenticated client.
- **Status change messages** are emitted whenever current stage, goal stage, in-flight work, notices, or warnings change.
- Downstream nodes are free to react to status changes however they like; the tracker does not prescribe or coordinate those handlers.

### Division of responsibility

| Responsibility | Owner |
| --- | --- |
| OAuth, token storage, token refresh | **youtube-account** config node |
| Authenticated YouTube API client | **youtube-account** (shared) |
| Poll `liveBroadcast` (and related resources as needed) | **youtube-stream-tracker** |
| Map YouTube `lifeCycleStatus` → internal stage | **youtube-stream-tracker** |
| Create broadcast / stream via API (when goal requires it) | **youtube-stream-tracker** |
| Transition broadcast status (`testing`, `live`, `complete`, etc.) via API | **youtube-stream-tracker** |
| Emit status change messages (including notices and warnings) | **youtube-stream-tracker** |
| Bind broadcast to stream | **External** — e.g. `liveBroadcasts.bind`, YouTube Studio, or another flow; tracker emits a **warning** if progression requires bind and it has not happened |
| Start/stop RTMP ingest, encoder control, operator steps | **External** — optional listeners react to status changes (hardware, OBS, scripts, etc.) |
| Embed monitor player, ad breaks, post-broadcast reference | **External** — optional listeners |

**External** means out of scope for these nodes but achievable elsewhere. **Bind vs ingest** are different external actions: [`liveBroadcasts.bind`](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind) links the broadcast and stream **on YouTube**; RTMP ingest sends encoded video **to** that stream’s ingest URL. The tracker handles neither. For bind, it **warns** when it would be needed; for ingest, it only reports status — listeners may act when they see relevant stage changes.

---

## Node surfaces

### youtube-account (configuration node)

Analogous to an **MQTT broker** config node: not placed on the canvas, not wired, edited from **Configuration nodes** (or when configuring a youtube-stream-tracker). Multiple trackers (or other future nodes) reference the same account by id.

#### Settings (non-secret)

| Field | Required | Description |
| --- | --- | --- |
| `name` | no | Label shown in Configuration nodes and tracker dropdown (e.g. “Church channel”) |
| `channelId` | no | Default YouTube channel id; used when creating resources if not overridden on the tracker |

#### Credentials (encrypted)

Stored via Node-RED’s credentials API on the config node (same security model as MQTT broker username/password).

| Field | Required | Description |
| --- | --- | --- |
| OAuth client id / secret | yes | Google Cloud OAuth client for YouTube Data API v3 |
| Access / refresh tokens | yes | Obtained through OAuth consent flow; refresh handled here |
| (optional) token expiry | — | Internal; used to refresh before API calls |

**Scopes** must include YouTube Live Streaming (e.g. `https://www.googleapis.com/auth/youtube` or the narrower live scope your implementation chooses). Token **refresh runs once** in the account config node so every referencing tracker shares a valid client.

#### Behaviour

- On deploy, validate credentials; surface auth errors to referencing nodes (trackers should emit `error` if the account is not usable).
- Expose an authenticated API helper to referencing nodes (implementation detail: shared module or runtime lookup by config node id).
- Optional: editor button to (re)run OAuth consent flow.

Other nodes that need YouTube API access (e.g. a future external bind helper in the same package) should reference **youtube-account**, not duplicate OAuth settings.

---

### youtube-stream-tracker (flow node)

Placed on the canvas and wired like any flow node. References a **youtube-account** config node for all API calls.

#### Settings (editor / deploy-time)

| Field | Required | Description |
| --- | --- | --- |
| `name` | no | Node label in the editor |
| `account` | yes | Reference to a **youtube-account** config node (dropdown, like MQTT broker) |
| `broadcastId` | conditional | Existing `liveBroadcast` id. Omit if the tracker should create one when goal is `created` or later |
| `streamId` | conditional | Existing `liveStream` id. Omit if the tracker should create one when needed |
| `broadcastTitle` | conditional | Used when creating a new broadcast |
| `streamTitle` | conditional | Used when creating a new stream |
| `skipTesting` | no | If `true`, canonical path skips `testStarting` / `testing` (Stage 3); from `ready`, next step toward `live*` is `liveStarting` |
| `pollIntervalNormal` | no | Default **20s** — routine polling |
| `pollIntervalActive` | no | Default **5s** — when status is a “Starting” state (`testStarting`, `liveStarting`), or after a recent API transition before expected stage appears |
| `pollIntervalExpensive` | no | Default **60s** — for quota-heavy calls per [YouTube API quota](https://developers.google.com/youtube/v3/getting-started#quota) |

The tracker detects bind state from YouTube (poll). It never calls `liveBroadcasts.bind`.

#### Inputs

Single input port. Messages use **`msg.payload`** with an **`action`** field. `msg.topic` is ignored unless an implementation explicitly documents otherwise.

##### Message shape

All input messages share this structure:

```json
{
  "action": "<action>",
  "goal": "<stage>"
}
```

The **`goal`** field is required only when `action` is `"set_goal"`. Additional properties on `msg.payload` (e.g. correlation ids) may be ignored or passed through on status output — implementation choice.

##### Set goal (`set_goal`)

Set the stage the tracker should move toward. See **Transition rules** below.

```json
{
  "action": "set_goal",
  "goal": "created"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `action` | string | Must be `"set_goal"` |
| `goal` | string | Target stage (lowercase); see valid goals below |

**Valid `goal` values:** `not_yet_set`, `not_exist`, `created`, `ready`, `teststarting`, `testing`, `livestarting`, `live`, `complete`

**Invalid / rejected goals:** `revoked`, `lifecyclestatusunspecified` — if current YouTube status is either of these, the tracker emits an error on the output and does not accept new goals until status recovers or the node is reset.

**Behavior:**

- If the goal is **behind** the current synced stage in the canonical sequence → emit a **notice** (`Stream is ahead of schedule`); do not regress YouTube.
- If the goal is **ahead** → set internal `goal_stage` and step one stage at a time along the canonical path (respecting `skipTesting`), performing in-scope YouTube API actions.
- If goal equals current stage → no-op except reaffirming `goal_stage`.

The tracker does **not** jump multiple YouTube API transitions in one tick unless YouTube itself advances through transient states (`testStarting` → `testing`, etc.) during polling.

##### Control actions

| `action` | Additional fields | Behavior |
| --- | --- | --- |
| `sync` | — | Force an immediate YouTube poll and resync internal stage from API (does not change `goal_stage`) |
| `reset` | optional `pollNow`: boolean | Clear goal, in-flight work, and set internal stage to `not_yet_set`; poll immediately if `pollNow` is true, else on next interval |

Examples:

```json
{ "action": "sync" }
```

```json
{ "action": "reset", "pollNow": true }
```

There is **no** `external_complete` input. The tracker does not wait on downstream handlers.

#### Outputs

Single output port: **status change messages**.

Emitted whenever something meaningful changes: synced stage, goal stage, transition plan, notices, warnings, errors, or completion of a step toward the goal. Downstream flows may subscribe and act arbitrarily; the tracker does not define those actions.

**Common payload shape:**

```json
{
  "event": "stage_changed",
  "current_stage": "ready",
  "goal_stage": "testing",
  "youtube_lifeCycleStatus": "ready",
  "broadcastId": "...",
  "streamId": "...",
  "bound": false,
  "account": "Church channel",
  "timestamp": "2026-05-30T12:00:00.000Z"
}
```

**`event` values:**

| `event` | When |
| --- | --- |
| `stage_changed` | `current_stage` updated from YouTube poll or after API transition |
| `goal_set` | Input `set_goal` accepted; `goal_stage` updated |
| `transition_planned` | Tracker will perform next in-scope YouTube step (includes `next_stage`, `goal_stage`) |
| `youtube_action_started` | API call in flight (e.g. `liveBroadcasts.transition`) |
| `youtube_action_done` | API call succeeded |
| `youtube_action_failed` | API error; includes `error` |
| `notice` | e.g. goal behind current stage — `"message": "Stream is ahead of schedule"` |
| `warning` | e.g. bind required but not done — see **Warnings** below |
| `error` | Unhandled status (`revoked`, `lifeCycleStatusUnspecified`), auth failure on account config, or fatal failure |
| `goal_reached` | Synced `current_stage` matches `goal_stage` |

**Transition planning payload** (when the tracker computes the next in-scope step):

```json
{
  "event": "transition_planned",
  "current_stage": "ready",
  "next_stage": "teststarting",
  "goal_stage": "testing",
  "youtube_method": "liveBroadcasts.transition",
  "broadcastStatus": "testing"
}
```

**Notice** (goal behind current stage):

```json
{
  "event": "notice",
  "message": "Stream is ahead of schedule",
  "current_stage": "live",
  "goal_stage": "testing"
}
```

**Error** (unhandled current stage such as `revoked`):

```json
{
  "event": "error",
  "message": "Can't handle the stream status",
  "current_stage": "revoked"
}
```

##### Warnings

When progression requires bind and poll shows the broadcast is **not** bound to the stream, the tracker emits:

```json
{
  "event": "warning",
  "code": "bind_required",
  "message": "Broadcast is not bound to stream; bind must be done externally before testing or live",
  "broadcastId": "...",
  "streamId": "...",
  "current_stage": "ready",
  "goal_stage": "testing"
}
```

The tracker does **not** call `liveBroadcasts.bind`. It may re-emit the warning if the goal is unchanged and bind is still missing (implementation may dedupe). Once poll shows bind complete, the tracker proceeds with in-scope API transitions without requiring any message back from downstream flows.

The tracker does **not** emit warnings for RTMP ingest start/stop. Listeners that care can watch for stages such as `ready` with a `testing` or `live` goal, or `live` with a `complete` goal, and act on their own schedule.

---

## Lifecycle stages

### Sequence explanation (Life of a Broadcast)

Stages and steps follow [Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast). The **Status** column is typical `liveBroadcast.status.lifeCycleStatus` (or a short chain when the doc describes a transition) for **steps** only; stages are grouping rows. **Owner** is who performs the step in this design (`Tracker`, **External**, or both where noted). Stage 2 (claim content) is **skipped**. Stage 3 (testing) is **optional** when `skipTesting` is true.

| Stage/Step | Status | Owner | Comments |
| --- | --- | --- | --- |
| Stage 1: Set up your broadcast | | | |
| Step 1.1: Create your broadcast | `created` (often becomes `ready` after required fields and settings are complete) | **Tracker** — `liveBroadcasts.insert` | |
| Step 1.2: Create your stream | `created` or `ready` (unchanged; this step is the `liveStream` resource, not the broadcast lifecycle) | **Tracker** — `liveStreams.insert` | |
| Step 1.3: Bind your broadcast to its stream | `ready` (typical before you transition to `testing` or `live`) | **External** — tracker warns if needed | YouTube API / operator (`liveBroadcasts.bind` or Studio workflow); not RTMP ingest |
| Stage 2: Claim your content | | | **Skipped** (per this spec) |
| Stage 3: Test (omit if `skipTesting`; proceed to Stage 4 instead) | | | |
| Step 3.1: Embed a monitor stream player | `ready` | **External** | |
| Step 3.2: Start your video | `ready` (encoder/stream activity; broadcast not transitioned yet) | **External** | Listeners may start ingest (encoder, OBS, etc.) on status |
| Step 3.3: Confirm your video stream is active | `ready` | **External** | Tracker may observe via poll; no separate handshake |
| Step 3.4: Transition your broadcast's status to testing | `testStarting` → `testing` (poll until `testing`) | **Tracker** — `liveBroadcasts.transition` | See [Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast) |
| Step 3.5: Completing your testing | `testing` (or briefly `ready` again if you unbind/recreate stream per the doc’s troubleshooting path) | **Tracker** (poll / goal) | |
| Step 3.6: Enable `autoStart` and `autoStop` properties | `testing` (optional; doc places this after successful testing, before the public broadcast) | **External** | |
| Stage 4: Broadcast (if you skipped Stage 3, follow the guide’s non-testing path) | | | |
| Step 4.1: Start your video | `testing` (or `ready` if no testing stage) | **External** | Listeners may start ingest on status |
| Step 4.2: Confirm your video stream is active | `testing` (or `ready` if no testing stage) | **External** | |
| Step 4.3: Transition your broadcast's status to live | `liveStarting` → `live` (or auto-start: may jump toward `live` without a manual transition; still expect `liveStarting` while the transition completes) | **Tracker** — `liveBroadcasts.transition` | Poll until `live` |
| Step 4.4: Insert ad breaks into your broadcast | `live` | **External** | |
| Stage 5: Conclude your broadcast | | | |
| Step 5.1: Stop streaming | `live` (until encoder stops and/or you transition or auto-stop runs) | **External** | Listeners may stop ingest on status |
| Step 5.2: Transition your broadcast's status to complete | `complete` (or auto-stop after ingest ends; ends in `complete`) | **Tracker** — `liveBroadcasts.transition` or auto-stop | |
| Stage 6: Create a reference | | | |
| Step 6.1: Poll the Data API for the video's status | `complete` (`status.uploadStatus` on the `video` resource is what you poll here) | **External** | |
| Step 6.2: Create a reference from the processed video | `complete` | **External** | |

### Tracked stages (internal)

Typical order of `liveBroadcast.status.lifeCycleStatus` values for **this** spec (Stage 2 skipped; Stage 3 optional when `skipTesting`). Transient “starting” states may last seconds to about a minute while YouTube completes the transition ([Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast)).

There are also synthetic and error states the tracker tracks:

| Stage | Source | Notes |
| --- | --- | --- |
| `not_yet_set` | synthetic | Initial state until first successful poll; tracker starts here |
| `not_exist` | synthetic | Broadcast id configured but resource missing; create when goal advances |
| `created` | YouTube | |
| `ready` | YouTube | |
| `teststarting` | YouTube | Omitted from path when `skipTesting` |
| `testing` | YouTube | Omitted when `skipTesting` |
| `livestarting` | YouTube | When going to `live`, including after `testing` or directly from `ready` if you skip testing |
| `live` | YouTube | |
| `complete` | YouTube | |
| `revoked` | YouTube | Admin removal; error; not a valid goal |
| `lifecyclestatusunspecified` | YouTube | Unset/unknown in some clients; error; not a valid goal |

Other documented values are not part of the normal forward sequence. Troubleshooting can briefly revisit `ready` while still bound (e.g. unbind/recreate stream per the guide) before returning to `testing` / `livestarting` again.

YouTube API values use mixed case (`testStarting`, `liveStarting`, `lifeCycleStatusUnspecified`); the tracker normalizes to lowercase internally and may uppercase in events for display.

**Canonical sequence** (with testing):

`not_yet_set` → `not_exist` → `created` → `ready` → `teststarting` → `testing` → `livestarting` → `live` → `complete`

With `skipTesting`, from `ready` the next forward step toward live is `livestarting` (not `teststarting`).

### YouTube status mapping (poll / sync)

On each poll, map `liveBroadcast.status.lifeCycleStatus` from the API to internal `current_stage`:

| API `lifeCycleStatus` | Internal stage |
| --- | --- |
| `created` | `created` |
| `ready` | `ready` |
| `testStarting` | `teststarting` |
| `testing` | `testing` |
| `liveStarting` | `livestarting` |
| `live` | `live` |
| `complete` | `complete` |
| `revoked` | `revoked` |
| `lifeCycleStatusUnspecified` | `lifecyclestatusunspecified` |

Additional synthetic mapping:

- Before first successful poll → `not_yet_set`
- Configured `broadcastId` but resource 404 / missing → `not_exist`

The **`sync`** action forces an immediate poll and updates `current_stage` without changing `goal_stage`. The **`reset`** action clears goal and in-flight work and sets internal stage to `not_yet_set`.

---

## Transition rules

Input messages with **`action: "set_goal"`** and **`goal`** set to one of: `not_yet_set`, `not_exist`, `created`, `ready`, `teststarting`, `testing`, `livestarting`, `live`, `complete` (lowercase).

**Invalid goals:** do not send `goal: "revoked"` or `goal: "lifecyclestatusunspecified"` — they are not valid goals.

Internally, the tracker maps `(current_stage, goal)` to the transition matrix in the **Appendix** (key `towards_<goal>` per current state).

When the tracker receives **`set_goal`**:

1. **Goal behind current stage** (in the canonical sequence) → emit **`notice`**: `"Stream is ahead of schedule"`. Do not regress YouTube.
2. **Goal ahead of current stage** → set `goal_stage` and compute **`next_stage`** as one step forward on the canonical path toward the goal (respecting `skipTesting`). Emit **`transition_planned`** with `next_stage` and `goal_stage`, then perform in-scope YouTube actions or poll until YouTube catches up.
3. **Goal equals current stage** → emit **`goal_reached`** (once per goal); reaffirm `goal_stage`.
4. **Current stage is `revoked` or `lifecyclestatusunspecified`** → emit **`error`**: `"Can't handle the stream status"`. Reject further goals until reset or recovery.

**Truth from YouTube:** `current_stage` changes only from polling (or immediately after a successful API call that YouTube reflects). Planning uses `current_stage` + `goal_stage`; it does not assume a transition succeeded until the next poll confirms it.

### `skipTesting` overrides for `next_stage`

The reference matrix below assumes the testing path (`ready` → `teststarting` → …). When `skipTesting` is true, override **`next_stage`** from `ready` toward any live-related goal: use `livestarting` instead of `teststarting`. Similarly, from `created` toward live goals, advance to `ready` then `livestarting`, skipping `teststarting` / `testing`.

Example: from `ready` with goal `live`, without testing: `next_stage` is `livestarting`, not `teststarting`.

---

## Internal state machine

The tracker implements the forward-only stepping logic defined in **Transition rules** and the **Appendix: transition matrix**, and **executes** in-scope YouTube steps itself.

### Polling

The tracker runs an internal timer:

| Condition | Interval |
| --- | --- |
| Normal | `pollIntervalNormal` (default 20s) |
| Status is `testStarting` or `liveStarting` | `pollIntervalActive` (default 5s) |
| Recent API transition, expected stage not yet seen | `pollIntervalActive` (default 5s) |
| Quota-expensive operation | `pollIntervalExpensive` (default 60s) |

On each poll, the tracker updates `current_stage` from `liveBroadcast.status.lifeCycleStatus` (and synthetic states when ids are missing or resources 404), and updates bind detection from the broadcast resource. All API calls use the referenced **youtube-account** client.

### Forward step selection

Given `current_stage` and `goal_stage`:

1. If the account config is invalid or auth fails → output `error`; stop automation.
2. If `current_stage` is `revoked` or `lifecyclestatusunspecified` → output `error`; stop automation.
3. If `goal_stage` is behind `current_stage` in the canonical sequence → output `notice` (`Stream is ahead of schedule`).
4. If `goal_stage` equals `current_stage` → output `goal_reached` if not already signaled for this goal.
5. Otherwise determine **`next_stage`** — one step forward on the canonical path (respecting `skipTesting`).
6. If **`next_stage`** requires bind (typically before first transition to `testing` or `live`) and poll shows not bound → output `warning` (`bind_required`); do not call bind; retry on subsequent polls.
7. Otherwise perform the **in-scope YouTube API** action for `next_stage` (create, transition, etc.).
8. Poll until YouTube reflects the new status before planning the following step.

### Mapping: stage → tracker action

| From → To (forward) | Mechanism |
| --- | --- |
| `not_yet_set` → (sync) | Poll only |
| `not_exist` → `created` | Tracker: create broadcast |
| `created` → `ready` | Poll until YouTube marks ready (or tracker update) |
| `ready` → `teststarting` | Warn if not bound; then tracker: transition to `testing` (YouTube enters `testStarting`) |
| `teststarting` → `testing` | Poll until `testing` |
| `testing` → `livestarting` | Tracker: transition to `live` |
| `ready` → `livestarting` (skip testing) | Warn if not bound; then tracker: transition to `live` |
| `livestarting` → `live` | Poll until `live` |
| `live` → `complete` | Tracker: transition to `complete` |

External steps (RTMP ingest, bind, operator actions) are not rows in this table. Downstream flows may use emitted status messages to time those actions; the tracker does not block on them.

---

## Example flow wiring

```
Configuration nodes (not on canvas):
  [ youtube-account: "Church channel" ]  ← OAuth, token refresh

Flow:
[ UI / schedule ] ──set_goal/live──► [ youtube-stream-tracker ] ──status──► [ dashboard / log ]
                                   account: Church channel                    │
                                                                                ├──► [ optional: bind elsewhere ]
                                                                                ├──► [ optional: start/stop ingest ]
                                                                                └──► [ optional: anything else ]
```

1. Create a **youtube-account** config node (Configuration nodes → add, or via tracker’s account dropdown). Complete OAuth once.
2. Drop a **youtube-stream-tracker** on the flow; select that account, set `broadcastId` / `streamId` (or creation titles) and poll options.
3. Wire the tracker output to status UI, debug, or logic that reacts to `stage_changed`, `warning`, etc.
4. Optionally add parallel **external** flows that listen for relevant status (or warnings) and perform bind, ingest, or other work — **not** wired back into the tracker input.
5. Send a goal when the show state should advance, e.g. `{ "action": "set_goal", "goal": "testing" }` or `{ "action": "set_goal", "goal": "live" }`.

A second tracker for another broadcast can reuse the same **youtube-account** with different `broadcastId` / `streamId`.

---

## Implementation notes

- **Package:** custom nodes under `node-red-contrib-youtube-stream-tracker` (or project-local nodes directory). Register two types: config node `youtube-account`, flow node `youtube-stream-tracker`.
- **Config node pattern:** same Node-RED model as `mqtt-broker` — `category: "config"`, credentials on the config node, flow nodes hold `account: "<config-node-id>"`.
- **Auth:** OAuth client credentials and tokens live on **youtube-account** only; token refresh is centralized there. Scopes must include YouTube Live Streaming.
- **Idempotency:** safe to redeploy; tracker reloads settings and polls before acting; account config reloads tokens.
- **Quota:** prefer `liveBroadcasts.list` / `get` by id over search; align expensive operations with `pollIntervalExpensive`.
- **Testing path:** editor checkbox `skipTesting` on the tracker switches canonical path; apply **skipTesting overrides** in Transition rules.

---

## Appendix: transition matrix (reference for implementation)

The tracker must implement this matrix when handling **`set_goal`** inputs. For each `(current_stage, goal)` pair, look up the row for `current_stage` and the key `towards_<goal>` in the appendix JSON:

- If the result is **`notice`**, emit a status message with `event: "notice"` and `"message": "Stream is ahead of schedule"`. Do not change YouTube.
- If the result is **`error`**, emit a status message with `event: "error"` and `"message": "Can't handle the stream status"` (current stage `revoked` or `lifecyclestatusunspecified`).
- Otherwise emit **`transition_planned`** with `next_stage` and `goal_stage` taken from the matrix entry’s `next_state` and `goal_state`, then act or poll as described in **Internal state machine**.

Apply **skipTesting overrides** where noted in Transition rules (replace `teststarting` with `livestarting` on the `ready` row toward live goals).

States in the matrix use lowercase goal names; synthetic poll states map as: `NOT_YET_SET` → `not_yet_set`, `NOT_EXIST` → `not_exist`, etc. Matrix entry `data.action` values map to output events: `transition` → `transition_planned`, `notice` → `notice`, `log` → `error`.

```json
{
  "state": {
    "status": "NOT_YET_SET",
    "data": {
      "source": "youtube.liveBroadcast.status.lifeCycleStatus"
    }
  },
  "transitions": {
    "NOT_YET_SET": {
      "towards_not_yet_set": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_yet_set",
          "goal_state": "not_yet_set"
        }
      },
      "towards_not_exist": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "not_exist"
        }
      },
      "towards_created": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "created"
        }
      },
      "towards_ready": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "ready"
        }
      },
      "towards_teststarting": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "teststarting"
        }
      },
      "towards_testing": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "testing"
        }
      },
      "towards_livestarting": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "livestarting"
        }
      },
      "towards_live": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "live"
        }
      },
      "towards_complete": {
        "status": "NOT_YET_SET",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "complete"
        }
      }
    },
    "NOT_EXIST": {
      "towards_not_yet_set": {
        "status": "NOT_EXIST",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_not_exist": {
        "status": "NOT_EXIST",
        "data": {
          "action": "transition",
          "next_state": "not_exist",
          "goal_state": "not_exist"
        }
      },
      "towards_created": {
        "status": "NOT_EXIST",
        "data": {
          "action": "transition",
          "next_state": "created",
          "goal_state": "created"
        }
      },
      "towards_ready": {
        "status": "NOT_EXIST",
        "data": {
          "action": "transition",
          "next_state": "created",
          "goal_state": "ready"
        }
      },
      "towards_teststarting": {
        "status": "NOT_EXIST",
        "data": {
          "action": "transition",
          "next_state": "created",
          "goal_state": "teststarting"
        }
      },
      "towards_testing": {
        "status": "NOT_EXIST",
        "data": {
          "action": "transition",
          "next_state": "created",
          "goal_state": "testing"
        }
      },
      "towards_livestarting": {
        "status": "NOT_EXIST",
        "data": {
          "action": "transition",
          "next_state": "created",
          "goal_state": "livestarting"
        }
      },
      "towards_live": {
        "status": "NOT_EXIST",
        "data": {
          "action": "transition",
          "next_state": "created",
          "goal_state": "live"
        }
      },
      "towards_complete": {
        "status": "NOT_EXIST",
        "data": {
          "action": "transition",
          "next_state": "created",
          "goal_state": "complete"
        }
      }
    },
    "CREATED": {
      "towards_not_yet_set": {
        "status": "CREATED",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_not_exist": {
        "status": "CREATED",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_created": {
        "status": "CREATED",
        "data": {
          "action": "transition",
          "next_state": "created",
          "goal_state": "created"
        }
      },
      "towards_ready": {
        "status": "CREATED",
        "data": {
          "action": "transition",
          "next_state": "ready",
          "goal_state": "ready"
        }
      },
      "towards_teststarting": {
        "status": "CREATED",
        "data": {
          "action": "transition",
          "next_state": "ready",
          "goal_state": "teststarting"
        }
      },
      "towards_testing": {
        "status": "CREATED",
        "data": {
          "action": "transition",
          "next_state": "ready",
          "goal_state": "testing"
        }
      },
      "towards_livestarting": {
        "status": "CREATED",
        "data": {
          "action": "transition",
          "next_state": "ready",
          "goal_state": "livestarting"
        }
      },
      "towards_live": {
        "status": "CREATED",
        "data": {
          "action": "transition",
          "next_state": "ready",
          "goal_state": "live"
        }
      },
      "towards_complete": {
        "status": "CREATED",
        "data": {
          "action": "transition",
          "next_state": "ready",
          "goal_state": "complete"
        }
      }
    },
    "READY": {
      "towards_not_yet_set": {
        "status": "READY",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_not_exist": {
        "status": "READY",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_created": {
        "status": "READY",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_ready": {
        "status": "READY",
        "data": {
          "action": "transition",
          "next_state": "ready",
          "goal_state": "ready"
        }
      },
      "towards_teststarting": {
        "status": "READY",
        "data": {
          "action": "transition",
          "next_state": "teststarting",
          "goal_state": "teststarting"
        }
      },
      "towards_testing": {
        "status": "READY",
        "data": {
          "action": "transition",
          "next_state": "teststarting",
          "goal_state": "testing"
        }
      },
      "towards_livestarting": {
        "status": "READY",
        "data": {
          "action": "transition",
          "next_state": "teststarting",
          "goal_state": "livestarting"
        }
      },
      "towards_live": {
        "status": "READY",
        "data": {
          "action": "transition",
          "next_state": "teststarting",
          "goal_state": "live"
        }
      },
      "towards_complete": {
        "status": "READY",
        "data": {
          "action": "transition",
          "next_state": "teststarting",
          "goal_state": "complete"
        }
      }
    },
    "TESTSTARTING": {
      "towards_not_yet_set": {
        "status": "TESTSTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_not_exist": {
        "status": "TESTSTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_created": {
        "status": "TESTSTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_ready": {
        "status": "TESTSTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_teststarting": {
        "status": "TESTSTARTING",
        "data": {
          "action": "transition",
          "next_state": "teststarting",
          "goal_state": "teststarting"
        }
      },
      "towards_testing": {
        "status": "TESTSTARTING",
        "data": {
          "action": "transition",
          "next_state": "testing",
          "goal_state": "testing"
        }
      },
      "towards_livestarting": {
        "status": "TESTSTARTING",
        "data": {
          "action": "transition",
          "next_state": "testing",
          "goal_state": "livestarting"
        }
      },
      "towards_live": {
        "status": "TESTSTARTING",
        "data": {
          "action": "transition",
          "next_state": "testing",
          "goal_state": "live"
        }
      },
      "towards_complete": {
        "status": "TESTSTARTING",
        "data": {
          "action": "transition",
          "next_state": "testing",
          "goal_state": "complete"
        }
      }
    },
    "TESTING": {
      "towards_not_yet_set": {
        "status": "TESTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_not_exist": {
        "status": "TESTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_created": {
        "status": "TESTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_ready": {
        "status": "TESTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_teststarting": {
        "status": "TESTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_testing": {
        "status": "TESTING",
        "data": {
          "action": "transition",
          "next_state": "testing",
          "goal_state": "testing"
        }
      },
      "towards_livestarting": {
        "status": "TESTING",
        "data": {
          "action": "transition",
          "next_state": "livestarting",
          "goal_state": "livestarting"
        }
      },
      "towards_live": {
        "status": "TESTING",
        "data": {
          "action": "transition",
          "next_state": "livestarting",
          "goal_state": "live"
        }
      },
      "towards_complete": {
        "status": "TESTING",
        "data": {
          "action": "transition",
          "next_state": "livestarting",
          "goal_state": "complete"
        }
      }
    },
    "LIVESTARTING": {
      "towards_not_yet_set": {
        "status": "LIVESTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_not_exist": {
        "status": "LIVESTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_created": {
        "status": "LIVESTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_ready": {
        "status": "LIVESTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_teststarting": {
        "status": "LIVESTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_testing": {
        "status": "LIVESTARTING",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_livestarting": {
        "status": "LIVESTARTING",
        "data": {
          "action": "transition",
          "next_state": "livestarting",
          "goal_state": "livestarting"
        }
      },
      "towards_live": {
        "status": "LIVESTARTING",
        "data": {
          "action": "transition",
          "next_state": "live",
          "goal_state": "live"
        }
      },
      "towards_complete": {
        "status": "LIVESTARTING",
        "data": {
          "action": "transition",
          "next_state": "live",
          "goal_state": "complete"
        }
      }
    },
    "LIVE": {
      "towards_not_yet_set": {
        "status": "LIVE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_not_exist": {
        "status": "LIVE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_created": {
        "status": "LIVE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_ready": {
        "status": "LIVE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_teststarting": {
        "status": "LIVE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_testing": {
        "status": "LIVE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_livestarting": {
        "status": "LIVE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_live": {
        "status": "LIVE",
        "data": {
          "action": "transition",
          "next_state": "live",
          "goal_state": "live"
        }
      },
      "towards_complete": {
        "status": "LIVE",
        "data": {
          "action": "transition",
          "next_state": "complete",
          "goal_state": "complete"
        }
      }
    },
    "COMPLETE": {
      "towards_not_yet_set": {
        "status": "COMPLETE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_not_exist": {
        "status": "COMPLETE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_created": {
        "status": "COMPLETE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_ready": {
        "status": "COMPLETE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_teststarting": {
        "status": "COMPLETE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_testing": {
        "status": "COMPLETE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_livestarting": {
        "status": "COMPLETE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_live": {
        "status": "COMPLETE",
        "data": {
          "action": "notice",
          "message": "Stream is ahead of schedule"
        }
      },
      "towards_complete": {
        "status": "COMPLETE",
        "data": {
          "action": "transition",
          "next_state": "complete",
          "goal_state": "complete"
        }
      }
    },
    "REVOKED": {
      "towards_not_yet_set": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_not_exist": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_created": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_ready": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_teststarting": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_testing": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_livestarting": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_live": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_complete": {
        "status": "REVOKED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      }
    },
    "UNSPECIFIED": {
      "towards_not_yet_set": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_not_exist": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_created": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_ready": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_teststarting": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_testing": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_livestarting": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_live": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      },
      "towards_complete": {
        "status": "UNSPECIFIED",
        "data": {
          "action": "log",
          "level": "error",
          "message": "Can't handle the stream status"
        }
      }
    }
  }
}
```

---

## User documentation (required content)

This section specifies what the **package user guide** (README or dedicated docs shipped with `node-red-contrib-youtube-stream-tracker`) must cover. It is not end-user prose here — it is a checklist for whoever writes the documentation.

### Overview and installation

- Package name, Node-RED minimum version, and install command (`npm install …` or palette install).
- Summary of the two node types (**youtube-account** config node vs **youtube-stream-tracker** flow node) and the MQTT-broker-style split.
- Link to this specification (`YouTubeTracker.md`) for behaviour, lifecycle, and transition rules.
- Link to Google’s [Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast) for YouTube-side staging.

### Prerequisites (before OAuth)

Document that the **Google account / YouTube channel** used for OAuth must already be able to live stream:

- Channel verified; no live streaming restrictions in the past 90 days ([Get started with live streaming](https://support.google.com/youtube/answer/2474026)).
- Live streaming enabled on the channel (first-time enablement can take up to 24 hours — [Create a live stream with an encoder](https://support.google.com/youtube/answer/2907883)).
- If API calls return `insufficientPermissions`, the channel may not be eligible for live streaming ([Live Streaming API authentication](https://developers.google.com/youtube/v3/live/authentication)).

**Service accounts are not supported** for YouTube Live. Using one yields `NoLinkedYouTubeAccount` ([YouTube authentication guide](https://developers.google.com/youtube/v3/guides/authentication), [Live Streaming authentication](https://developers.google.com/youtube/v3/live/authentication)).

### OAuth and Google Cloud setup (required section)

The user guide **must** include a step-by-step OAuth section. Use the official guides as references and link them prominently:

| Topic | Official reference |
| --- | --- |
| YouTube Data API getting started | [YouTube Data API overview](https://developers.google.com/youtube/v3/getting-started) |
| OAuth overview (Data API) | [Implementing OAuth 2.0 Authorization](https://developers.google.com/youtube/v3/guides/authentication) |
| OAuth overview (Live Streaming) | [Live Streaming API authentication](https://developers.google.com/youtube/v3/live/authentication) |
| Web server OAuth flow (typical for Node-RED callback) | [OAuth 2.0 for web server apps (Data API)](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps) / [Live Streaming variant](https://developers.google.com/youtube/v3/live/guides/auth/server-side-web-apps) |
| API quota | [Quota and compliance](https://developers.google.com/youtube/v3/getting-started#quota) |

#### Step 1 — Google Cloud project

1. Sign in to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one) — see [Getting started](https://developers.google.com/youtube/v3/getting-started).

#### Step 2 — Enable the API

1. Open [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) in the API Library.
2. Enable it for the project ([Enabled APIs & services](https://console.cloud.google.com/apis/dashboard)).

Live Streaming uses the **YouTube Data API v3** (same API; `liveBroadcast`, `liveStream`, etc.). No separate “Live Streaming API” enable switch.

#### Step 3 — OAuth consent screen

1. Configure the OAuth consent screen in [Google Auth platform](https://console.cloud.google.com/auth/overview) (Branding, Audience, Data access).
2. Choose **Internal** (Google Workspace only) or **External** (typical for a church / personal channel).
3. For **External** apps in **Testing**, add every Google account that will authorize as a **test user** (otherwise consent fails with “access blocked”).
4. Under **Data access** → **Add or remove scopes**, add the scope(s) the package requests (see below).
5. Note: moving from Testing to **Production** may require [Google verification](https://support.google.com/cloud/answer/9110914) if using sensitive/restricted scopes.

#### Step 4 — OAuth client credentials

1. Open [Credentials](https://console.cloud.google.com/apis/credentials).
2. Create **OAuth client ID**.
3. Application type: document which type the package uses (likely **Web application** if Node-RED serves an `/auth/callback` URL on the Node-RED host, or **Desktop app** if using a localhost / out-of-band flow — the user guide must match the implementation).
4. **Authorized redirect URIs** must match **exactly** what the **youtube-account** node uses (including scheme, host, port, and path). Mismatch causes `redirect_uri_mismatch`. Document the exact URI(s) to register, e.g. `http://127.0.0.1:1880/<package-auth-path>` if that is what the node opens.
5. Save **Client ID** and **Client secret** — entered into the **youtube-account** config node (credentials), not into flow nodes.

#### Step 5 — Scopes

Document the **exact scope string(s)** the package requests during consent. For this project:

- **Required:** one scope that allows managing live broadcasts and streams, e.g.  
  `https://www.googleapis.com/auth/youtube`  
  or  
  `https://www.googleapis.com/auth/youtube.force-ssl`  
  (both support `liveBroadcasts` / `liveStreams` write operations such as `insert` and `transition`; see method docs e.g. [`liveBroadcasts.transition`](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition)).
- **Do not** combine `youtube` with `youtube.readonly` (invalid scope combination).
- **Do not** request multiple overlapping YouTube scopes unless tested — combining `youtube` and `youtube.force-ssl` has been reported to fail; request **one** write scope only.
- **`youtube.readonly` alone is insufficient** for transitions and resource creation.

List scopes in the user guide and explain what the consent screen will show (“Manage your YouTube account”).

#### Step 6 — Authorize in Node-RED

Document the **youtube-account**-specific flow (wording depends on implementation, but all steps must appear):

1. Open **Configuration nodes** → add or edit **youtube-account**.
2. Enter OAuth **Client ID** and **Client secret** (from Step 4).
3. Click the package’s **Authenticate** / **Grant access** control (or follow the documented URL if manual).
4. Browser opens Google sign-in → choose the **same Google account** that owns the target YouTube channel.
5. Grant the requested scope(s).
6. Confirm redirect back to Node-RED succeeds; config node shows **connected** / token valid (exact UI TBD).
7. **Deploy** flows after auth; tokens are stored encrypted in Node-RED credentials.
8. Optional: set **channelId** on the account config if the Google account manages multiple channels.

#### Step 7 — Verify auth

Document a simple verification:

- Account config shows no auth error after deploy.
- A **youtube-stream-tracker** with a known `broadcastId` emits `stage_changed` (or polls without `error` / auth failure).
- On failure, see troubleshooting below.

#### OAuth troubleshooting (required in user guide)

| Symptom | Likely cause | User doc should say |
| --- | --- | --- |
| `redirect_uri_mismatch` | Redirect URI not registered or typo | Match URI exactly in Cloud Console and node settings |
| Access blocked / app not verified | External app in Testing, user not listed | Add user as test user on consent screen |
| `NoLinkedYouTubeAccount` | Service account used | Use OAuth user flow, not service account |
| `insufficientPermissions` | Channel not live-enabled | Complete YouTube live streaming enablement |
| `invalid_scope` | Conflicting scopes requested | Request only one write scope (see Step 5) |
| Token expired / repeated prompts | Refresh token missing or revoked | Re-run authenticate; check client type and `prompt`/`access_type` if web flow |
| `403` quota | API quota exhausted | [Quota](https://developers.google.com/youtube/v3/getting-started#quota); reduce poll rates |

Link to [Troubleshoot your YouTube live stream](https://support.google.com/youtube/answer/2853835) for encoder/stream-key issues (external to this package).

### Configuring youtube-account

- Where to find Configuration nodes in Node-RED.
- Field reference (name, `channelId`, credentials).
- That one account config can be shared by multiple trackers.
- How to re-authenticate or rotate client secret.
- **Do not** commit `flows_cred.json` or credential backups to git.

### Configuring youtube-stream-tracker

- Selecting the **account** dropdown.
- `broadcastId` / `streamId` vs creation titles.
- `skipTesting` and poll intervals.
- Input messages: `{ "action": "set_goal", "goal": "<stage>" }`, `{ "action": "sync" }`, `{ "action": "reset" }` (optional `pollNow` on reset).
- Output events and `bind_required` warnings.
- Example flow wiring (may mirror this spec’s diagram).

### External steps (bind, ingest)

- Bind is **external**; link to [`liveBroadcasts.bind`](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind) and Studio/encoder docs ([encoder setup](https://support.google.com/youtube/answer/2907883)).
- Ingest (Tascam, OBS, etc.) is **external**; listeners react to tracker status messages.
- Cross-reference **Open questions** below for unsettled church/Tascam bind workflow.

### Operations and quota

- Default poll intervals and quota cost of `liveBroadcasts.get` / `transition`.
- Link to [quota](https://developers.google.com/youtube/v3/getting-started#quota).
- When to increase `pollIntervalExpensive`.

### Security and privacy

- OAuth tokens and client secret storage (Node-RED credentials file).
- Minimum scope principle.
- Who can access the Node-RED editor and Configuration nodes.

---

## Open questions

### Who performs bind in a Tascam-based church setup?

**Bind** (`liveBroadcasts.bind` or Studio equivalent) links the YouTube **broadcast** resource to the **live stream** resource. **Ingest** (e.g. Tascam **Stream** + RTMP) sends encoded video to that stream’s ingest URL. These are different operations; this document treats bind as **external** to the tracker node.

It is **not yet settled** for our church workflow:

- Whether bind is done only in **YouTube Studio** (or another API flow) before the Tascam is configured, with the Tascam handling **ingest only**.
- Whether the VS-R264 **YouTube** preset or **account linking** (firmware mentions fixing “Account linking with YouTube servers”) does anything beyond RTMP URL/key setup — and if so, whether that includes API-level bind or only credential/ingest configuration.

Tascam’s reference manual describes YouTube as an RTMP destination preset (URL + protocol); it does not document `liveBroadcasts.bind` or lifecycle management. Until we confirm our actual setup, treat bind as external and rely on the tracker’s `bind_required` warning when YouTube poll shows the broadcast is not bound.
