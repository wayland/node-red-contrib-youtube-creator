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
...or...
```
{
    "action": "log",
    "level": "error",
    "message": "Can't handle the stream status",
}
```

- If a towards_STATE transition would require going backwards in the Sequence 
  of States, then the action is a "notice" one, as per above.  
- If the towards_STATE transition would require going forward in the Sequence 
  of States, then the "next_state" is set to the next item in the sequence, and 
  the "goal_state" is set to the state we want to end up in
- If the current state is `revoked` or `lifeCycleStatusUnspecified`, then emit 
  the error instead.  These two states also cannot be goal states.  

## FSM JSON (paste into the Node-RED FSM config)

This JSON is structured per the manual for
`node-red-contrib-finite-statemachine`
([Manual](https://raw.githubusercontent.com/lutzer/node-red-contrib-finite-statemachine/master/MANUAL.md)).

- **States** match **Sequence of States**, plus `REVOKED` and `UNSPECIFIED` (for
  YouTube `revoked` and `lifeCycleStatusUnspecified`) so **`msg.control = sync`**
  can land there.
- **Valid intent topics** are `towards_<goal>` with `<goal>` in:
  `not_yet_set`, `not_exist`, `created`, `ready`, `teststarting`, `testing`,
  `livestarting`, `live`, `complete` (lowercase). Each transition **self-loops**
  the FSM `status`; YouTube truth still comes from **sync**.
- **Non-goal states:** `REVOKED` and `UNSPECIFIED` are **not goal states**, so
  there are **no** transitions like `towards_revoked` or
  `towards_lifecyclestatusunspecified` in this FSM. If your flow attempts to send
  those topics, the FSM node will treat them as invalid/unknown topics.
- **Current state `REVOKED` or `UNSPECIFIED`:** every *valid* `towards_*` goal
  emits the **`log`** payload below (emit error instead of `transition` / `notice`).
- **Payload shapes** match **Transitions**:
  - `transition`: `action`, `next_state`, `goal_state`
  - `notice`: `action`, `message` only
  - `log`: `action`, `level`, `message`
- **`next_state`** is one step forward on the canonical path that **includes**
  `teststarting` → `testing` → `livestarting`. If you **omit Stage 3**, override
  `next_state` from `READY` toward `live*` in a Function node (e.g. use
  `livestarting` instead of `teststarting`).


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

## Notes for the flow wiring

- **Intent (“towards”) messages:** set `msg.topic` to `towards_<goal>` with 
  `<goal>` one of `not_yet_set`, `not_exist`, `created`, `ready`, `teststarting`, 
  `testing`, `livestarting`, `live`, `complete` (lowercase). After the node 
  fires, read `msg.payload.data` for `action` and the fields that apply 
  (`goal_state` / `next_state` for `transition`; only `message` for `notice`; 
  `level` / `message` for `log`).
- **Non-goal goals:** do not send `towards_revoked` or
  `towards_lifecyclestatusunspecified` — those topics are intentionally *not*
  present in the FSM JSON.
- **Truth from YouTube:** map `liveBroadcast.status.lifeCycleStatus` from your 
  poll to `msg.control = "sync"` with a payload `{ "status": "<FSM state>" }` 
  where `<FSM state>` is `CREATED`, `READY`, `TESTSTARTING`, `TESTING`, 
  `LIVESTARTING`, `LIVE`, `COMPLETE`, `REVOKED`, `UNSPECIFIED`, or your synthetic 
  states (`NOT_YET_SET`, `NOT_EXIST`). Map API `liveStarting` → `LIVESTARTING`, 
  `lifeCycleStatusUnspecified` → `UNSPECIFIED`, etc.
- **`msg.control = "reset"`** returns to the JSON initial state (`NOT_YET_SET`), 
  per the node manual.

