# FSM plan: Track YouTube Live `status.lifeCycleStatus` (Node-RED)

## Goal

Track a YouTube Live broadcast’s `liveBroadcast.status.lifeCycleStatus` in 
Node-RED using `node-red-contrib-finite-statemachine`.

Source of truth for lifecycle values: the YouTube Live Streaming API 
`liveBroadcast` resource docs (`status.lifeCycleStatus`) at 
[`liveBroadcasts`](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts). 
The broadcast “staging” behavior (`testStarting`, `liveStarting`) is also 
described in [Life of a 
Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast).

## Approach (brief)

- Update the FSM as per the YouTube Sync mini-flow, below
- The FSM will be fed desired states that it should be transitioned towards. 
  This will trigger:
  - A state transition towards (but not necessarily into) the state we want, OR
  - An error that says that the YouTube stream is ahead of schedule


### YouTube Sync mini-flow

There should be a mini-flow something that periodically polls the YouTube stream 
and sets the current state in the FSM to the YouTube status using `msg.control= 
sync`.  This skips all the transitions, but keeps the FSM in sync with YouTube.  
* Normal polling interval: Every 20s
* If the current status is a “Starting” one: Every 5s
* If something has been triggered recently, but the expected state hasn’t 
  eventuated: every 5s
* If it’s an expensive query as per 
  https://developers.google.com/youtube/v3/getting-started#quota like a search 
  request: every minute

### FSM States

#### Sequence Explanation

Stages and steps follow [Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast). The **Status** column is typical `liveBroadcast.status.lifeCycleStatus` (or a short chain when the doc describes a transition) for **steps** only; stages are grouping rows. **Actor** is filled where a physical operator/device clearly performs that step.

**Tascam VS-R264 “Stream” button (fact check):** Tascam documents that the front-panel **STREAM** control turns **RTMP streaming on and off** (including simultaneous control of RTMP 1/2/3 after firmware V2.0.1)—i.e. it **starts and stops sending encoded video** to whatever ingest URL(s) you configured in the unit’s streaming settings, not a YouTube API call. By contrast, **Step 1.3 (bind)** is YouTube’s [`liveBroadcasts.bind`](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind) in the API (or equivalent workflow in YouTube Studio): it links the **broadcast** resource to the **live stream** resource on YouTube’s side. The encoder does not execute “bind”; you typically paste that stream’s **ingest URL + stream key** into the VS-R264 (or set it via its web UI/API), *after* the bind (or parallel setup) has given you those values. Marketing copy also describes “press STREAM to start streaming” once setup is done ([TASCAM VS-R264 product page](https://tascam.com/us/product/vs-r264/)).

| Stage/Step | Status | Actor | Comments |
| --- | --- | --- | --- |
| Stage 1: Set up your broadcast | | | |
| Step 1.1: Create your broadcast | `created` (often becomes `ready` after required fields and settings are complete) | | |
| Step 1.2: Create your stream | `created` or `ready` (unchanged; this step is the `liveStream` resource, not the broadcast lifecycle) | | |
| Step 1.3: Bind your broadcast to its stream | `ready` (typical before you transition to `testing` or `live`) | Not VS-R264 **Stream** — YouTube API / operator (`liveBroadcasts.bind` or Studio workflow) | |
| Stage 2: Claim your content | | | Skip this stage (per plan) |
| Stage 3: Test (omit this stage if the guide’s monitor-stream / testing path does not apply; proceed to Stage 4 instead) | | | |
| Step 3.1: Embed a monitor stream player | `ready` | | |
| Step 3.2: Start your video | `ready` (encoder/stream activity; broadcast not transitioned yet) | Tascam VS-R264 (press **Stream**) | |
| Step 3.3: Confirm your video stream is active | `ready` | | |
| Step 3.4: Transition your broadcast's status to testing | `testStarting` → `testing` (poll until `testing`; see [Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast)) | | |
| Step 3.5: Completing your testing | `testing` (or briefly `ready` again if you unbind/recreate stream per the doc’s troubleshooting path) | | |
| Step 3.6: Enable `autoStart` and `autoStop` properties | `testing` (optional; doc places this after successful testing, before the public broadcast) | | |
| Stage 4: Broadcast (if you skipped Stage 3, follow the guide’s non-testing path; see steps below) | | | |
| Step 4.1: Start your video | `testing` (or `ready` if no testing stage) | Tascam VS-R264 (press **Stream**) | |
| Step 4.2: Confirm your video stream is active | `testing` (or `ready` if no testing stage) | | |
| Step 4.3: Transition your broadcast's status to live | `liveStarting` → `live` (or auto-start: may jump toward `live` without a manual transition; still expect `liveStarting` while the transition completes) | | |
| Step 4.4: Insert ad breaks into your broadcast | `live` | | |
| Stage 5: Conclude your broadcast | | | |
| Step 5.1: Stop streaming | `live` (until encoder stops and/or you transition or auto-stop runs) | Tascam VS-R264 (STREAM **off** — same control as start; RTMP stops per Tascam docs) | |
| Step 5.2: Transition your broadcast's status to complete | `complete` (or auto-stop after ingest ends; ends in `complete`) | | |
| Stage 6: Create a reference | | | |
| Step 6.1: Poll the Data API for the video's status | `complete` (`status.uploadStatus` on the `video` resource is what you poll here) | | |
| Step 6.2: Create a reference from the processed video | `complete` | | |

#### Sequence of States

Typical order of `liveBroadcast.status.lifeCycleStatus` values for **this** plan 
(Stage 2 skipped; Stage 3 optional if you use the guide’s testing / 
monitor-stream path). Transient “starting” states may last seconds to about a 
minute while YouTube completes the transition ([Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast)).    

There are also some additions.  These are the states we want to track in the 
FSM.  

- `NOT_YET_SET` -- not a YouTube state; indicates that we need to sync from 
  YouTube.  This should be the starting state of the FSM.  
- `NOT_EXIST` -- not a YouTube state; indicates that the video in question 
  doesn't exist yet, and needs to be created
- `created`
- `ready`
- `testStarting` (only if you transition to `testing`; omit if you skip Stage 3)
- `testing` (omit if you skip Stage 3)
- `liveStarting` (when going to `live`, including after `testing` or directly from `ready` if you skip testing)
- `live`
- `complete`

Other documented values (not a normal forward sequence): `revoked` (admin 
removal); `lifeCycleStatusUnspecified` (unset/unknown in some clients). 
Troubleshooting can briefly revisit `ready` while still bound (e.g. 
unbind/recreate stream per the guide) before returning to `testing` / 
`liveStarting` again.

#### Transitions

- Each state defines the transition so that it ends up right back where it 
  started -- the state will only actually change when synced from YouTube
- Each transition should be called "towards_STATE", and the state it's 
  transitioning towards
- Each transaction will have the following data attached:
```
{
	"action": "transition",
	"next_state": "<state name>",
	"goal_state": "<state name>",
}
```
...or...
```
{
	"action": "notice",
	"message": "Stream is ahead of schedule",
}
```

- If a towards_STATE transition would require going backwards in the Sequence 
  of States, then the action is a "notice" one, as per above.  
- If the towards_STATE transition would require going forward in the Sequence 
  of States, then the "next_state" is set to the next item in the sequence, and 
  the "goal_state" is set to the state we want to end up in


## FSM JSON (paste into the Node-RED FSM config)

This JSON is structured per the manual for 
`node-red-contrib-finite-statemachine` 
([Manual](https://raw.githubusercontent.com/lutzer/node-red-contrib-finite-statemachine/master/MANUAL.md)).

- **States included**: every documented `status.lifeCycleStatus` value 
  (`created`, `ready`, `testStarting`, `testing`, `liveStarting`, `live`, 
  `complete`, `revoked`).  
- **Also included**: `lifeCycleStatusUnspecified` (seen in some client libraries 
  / “unknown” cases). If you don’t want it, remove the `UNSPECIFIED` state and 
  the `lifeCycleStatusUnspecified` transitions.  

```json
{
  "state": {
    "status": "UNSPECIFIED",
    "data": {
      "source": "youtube.liveBroadcast.status.lifeCycleStatus"
    }
  },
  "transitions": {
    "UNSPECIFIED": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "CREATED": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "READY": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "TESTSTARTING": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "TESTING": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "LIVESTARTING": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "LIVE": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "COMPLETE": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    },
    "REVOKED": {
      "lifeCycleStatusUnspecified": "UNSPECIFIED",
      "created": "CREATED",
      "ready": "READY",
      "testStarting": "TESTSTARTING",
      "testing": "TESTING",
      "liveStarting": "LIVESTARTING",
      "live": "LIVE",
      "complete": "COMPLETE",
      "revoked": "REVOKED"
    }
  }
}
```

## Notes for the flow wiring

- Drive transitions by setting `msg.topic` to the exact lifecycle string 
  returned by the API (case-sensitive as shown above): `created`, `ready`, 
  `testStarting`, `testing`, `liveStarting`, `live`, `complete`, `revoked` (and 
  optionally `lifeCycleStatusUnspecified`).   
- Use `msg.control = "reset"` to return to initial state, per the node manual.

